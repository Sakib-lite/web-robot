import { useEffect, useRef, useState } from 'react';
import { runTask, type StepRecord, type TaskResult } from '@/core/agent/loop';
import { createExtensionDriver } from '@/core/driver/extensionDriver';
import { createHttpPlane } from '@/core/local/httpPlane';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolDef } from '@/core/llm/chatClient';
import { resolveActiveProvider, type ProductStore } from '@/core/llm/providers';
import { getBackendUrl } from '@/core/telemetry/settings';
import { startTelemetry } from '@/core/telemetry/client';
import ResultView from './ResultView';

interface SkillOption {
  slug: string;
  name: string;
  description: string;
}

export default function TaskRunner({ store }: { store: ProductStore }) {
  const [task, setTask] = useState('');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skill, setSkill] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingProvider, setUsingProvider] = useState<string | null>(null);
  const [traceInfo, setTraceInfo] = useState<{ taskId: string; backendUrl: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${await getBackendUrl()}/skills`);
        if (!res.ok) return;
        const body = (await res.json()) as { skills?: SkillOption[] };
        setSkills(body.skills ?? []);
      } catch {
        // backend down - dropdown just stays empty
      }
    })();
  }, []);

  async function run() {
    setError(null);
    setResult(null);
    setSteps([]);
    setTraceInfo(null);

    const provider = await resolveActiveProvider(store);
    if (!provider) {
      setError('no active llm provider - add one in settings first');
      return;
    }
    setUsingProvider(`${provider.productId} · ${provider.model}`);

    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const chat = (messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse> =>
      chatCompletion(provider, { messages, tools, maxTokens: 8192, signal: controller.signal });

    const askUser = async (question: string) => window.prompt(`web-robot asks:\n${question}`);

    const backendUrl = await getBackendUrl();
    const telemetry = await startTelemetry(
      { taskText: task, product: provider.productId, model: provider.model, effort: provider.thinking ?? 'off' },
      backendUrl,
    );
    if (telemetry.taskId) setTraceInfo({ taskId: telemetry.taskId, backendUrl });

    // local workspace hands, when the backend offers them
    const plane = createHttpPlane(() => Promise.resolve(backendUrl));
    const workspaceInfo = await plane.describe().catch(() => null);
    const workspace = workspaceInfo?.enabled ? { plane, root: workspaceInfo.root } : undefined;

    // a selected skill injects its body as a preamble and may override defaults;
    // typing "/slug ..." selects the skill inline
    let selected = skill;
    let taskText = task;
    const slash = /^\/([a-z0-9-]+)\s+([\s\S]+)/i.exec(task.trim());
    if (slash && skills.some((s) => s.slug === slash[1])) {
      selected = slash[1]!;
      taskText = slash[2]!;
    }
    let preamble: string | undefined;
    let skillMaxSteps: number | undefined;
    let runProvider = provider;
    if (selected) {
      try {
        const res = await fetch(`${backendUrl}/skills/${encodeURIComponent(selected)}`);
        if (res.ok) {
          const full = (await res.json()) as { name?: string; body?: string; defaults?: Record<string, string> };
          if (full.defaults?.model) runProvider = { ...runProvider, model: full.defaults.model };
          if (full.defaults?.effort) runProvider = { ...runProvider, thinking: full.defaults.effort as 'off' | 'low' | 'high' | 'max' };
          if (full.defaults?.maxSteps) skillMaxSteps = Number(full.defaults.maxSteps);
          if (full.body) preamble = `SKILL "${full.name ?? selected}" - follow this workflow for the whole task:\n\n${full.body}`.slice(0, 8000);
        }
      } catch {
        // missing skill runs without the preamble
      }
    }
    const skillChat = (messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse> =>
      chatCompletion(runProvider, { messages, tools, maxTokens: 8192, signal: controller.signal });

    // heartbeat busy+currentTask during manual runs: the backend reaper must
    // see this run as alive or it will requeue the row mid-run
    const heartbeat = (state: string) =>
      fetch(`${backendUrl}/worker/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'panel-manual', state, ...(state === 'busy' && telemetry.taskId ? { currentTask: telemetry.taskId } : {}) }),
      }).catch(() => undefined);
    if (telemetry.taskId) void heartbeat('busy');
    const heartbeatTimer = telemetry.taskId ? setInterval(() => void heartbeat('busy'), 15000) : null;

    let taskResult: TaskResult | null = null;
    try {
      taskResult = await runTask(taskText, {
        driver: createExtensionDriver(),
        chat: skillChat,
        askUser,
        signal: controller.signal,
        telemetry,
        ...(workspace ? { workspace } : {}),
        ...(telemetry.taskId ? { taskId: telemetry.taskId } : {}),
        ...(preamble ? { preamble } : {}),
        ...(skillMaxSteps ? { maxSteps: skillMaxSteps } : {}),
        onStep: (step) => setSteps((prev) => [...prev, step]),
      });
      setResult(taskResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      const status = taskResult?.status ?? (controller.signal.aborted ? 'stopped' : 'failed');
      await telemetry.finish(status, taskResult?.summary, taskResult?.reason, taskResult?.steps.length ?? 0);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (telemetry.taskId) await heartbeat('idle');
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="runner">
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="e.g. open hackernews.com, go to the first story and summarize it"
        rows={3}
        disabled={running}
      />
      <div className="row">
        {skills.length > 0 && (
          <select value={skill} onChange={(e) => setSkill(e.target.value)} disabled={running} title={skills.find((s) => s.slug === skill)?.description ?? 'pick a skill'}>
            <option value="">no skill</option>
            {skills.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={running || !task.trim()} onClick={run}>
          run
        </button>
        <button className="danger" disabled={!running} onClick={stop}>
          stop
        </button>
        {running && <span className="muted">working…</span>}
        {!running && usingProvider && <span className="muted">using {usingProvider}</span>}
      </div>

      {error && <div className="note err">{error}</div>}

      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.index} className={step.ok ? 'step' : 'step failed'}>
              <span className="step-call">{step.call}</span>
              <span className="muted">{step.detail}</span>
            </li>
          ))}
        </ol>
      )}

      {traceInfo && (
        <div className="muted small">
          trace: {traceInfo.taskId.slice(0, 8)}… —{' '}
          <a href={`${traceInfo.backendUrl}/tasks/${traceInfo.taskId}/debug`} target="_blank" rel="noreferrer">
            open debug json
          </a>
        </div>
      )}

      {result && <ResultView result={result} />}
    </div>
  );
}
