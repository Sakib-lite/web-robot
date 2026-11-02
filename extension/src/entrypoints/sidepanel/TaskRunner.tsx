import { useEffect, useMemo, useRef, useState } from 'react';
import { runTask, type StepRecord, type TaskResult } from '@/core/agent/loop';
import { planTask } from '@/core/agent/planner';
import { createExtensionDriver } from '@/core/driver/extensionDriver';
import { createHttpPlane } from '@/core/local/httpPlane';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolDef } from '@/core/llm/chatClient';
import { resolveActiveProvider, type LlmProvider, type ProductStore, type StoredProductConfig } from '@/core/llm/providers';
import { getProduct, catalogModels, type Effort, type ProductId } from '@/core/llm/products';
import { getBackendUrl } from '@/core/telemetry/settings';
import { Chevron, Collapse } from './common/ui';
import { StepsEditor } from './StepsEditor';
import { ChatSection, type RecentTask } from './ChatSection';
import { startTelemetry } from '@/core/telemetry/client';
import ResultView from './ResultView';

interface SkillOption {
  slug: string;
  name: string;
  description: string;
}

export interface RunState {
  stepCount: number;
  snippet: string;
}

export default function TaskRunner({
  store,
  configs,
  customModels,
  onRunningChange,
}: {
  store: ProductStore;
  configs: StoredProductConfig[] | null;
  customModels: Partial<Record<ProductId, string[]>>;
  onRunningChange: (state: RunState | null) => void;
}) {
  const [task, setTask] = useState('');
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skill, setSkill] = useState('');
  const [contexts, setContexts] = useState<Array<{ slug: string; bytes: number }>>([]);
  const [context, setContext] = useState('');
  const [stepsMode, setStepsMode] = useState(false);
  const [taskSteps, setTaskSteps] = useState<string[]>([]);
  const [chatTaskId, setChatTaskId] = useState<number | ''>('');
  const [chatInput, setChatInput] = useState('');
  const [chatState, setChatState] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(true);
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [running, setRunning] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingProvider, setUsingProvider] = useState<string | null>(null);
  const [traceInfo, setTraceInfo] = useState<{ taskId: number; backendUrl: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeProduct = useMemo(() => {
    const active = configs?.find((c) => c.active);
    return active ? getProduct(active.productId) : null;
  }, [configs]);
  const modelOptions = useMemo(() => {
    if (!activeProduct) return [];
    const saved = configs?.find((c) => c.active)?.model ?? '';
    return catalogModels(activeProduct, [...(saved ? [saved] : []), ...(customModels[activeProduct.id] ?? [])]);
  }, [activeProduct, configs, customModels]);
  const effortOptions = activeProduct?.efforts ?? [];

  useEffect(() => {
    void (async () => {
      try {
        const base = await getBackendUrl();
        const [skillsRes, contextsRes, tasksRes] = await Promise.all([
          fetch(`${base}/skills`),
          fetch(`${base}/contexts`),
          fetch(`${base}/tasks?limit=12`),
        ]);
        if (skillsRes.ok) setSkills(((await skillsRes.json()) as { skills?: SkillOption[] }).skills ?? []);
        if (contextsRes.ok) setContexts(((await contextsRes.json()) as { contexts?: Array<{ slug: string; bytes: number }> }).contexts ?? []);
        if (tasksRes.ok) {
          const body = (await tasksRes.json()) as RecentTask[];
          setRecentTasks(Array.isArray(body) ? body : []);
          const finished = Array.isArray(body) ? body.find((t) => t.status !== 'queued' && t.status !== 'running') : undefined;
          if (finished) setChatTaskId(finished.id);
        }
      } catch {
      }
    })();
  }, []);

  async function run() {
    setError(null);
    setResult(null);
    setSteps([]);
    setTraceInfo(null);

    const askUser = async (question: string) => window.prompt(`web-robot asks:\n${question}`);

    const resolved = await resolveProvider();
    if (!resolved) return;
    const { backendUrl } = resolved;
    let runProvider = resolved.provider;

    setRunning(true);
    onRunningChange({ stepCount: 0, snippet: task.slice(0, 60) });
    const controller = new AbortController();
    abortRef.current = controller;

    setUsingProvider(`${runProvider.productId} · ${runProvider.model} · ${runProvider.thinking ?? 'off'}`);

    const telemetry = await startTelemetry(
      { taskText: task, product: runProvider.productId, model: runProvider.model, effort: runProvider.thinking ?? 'off', ...(effectiveSteps.length ? { steps: effectiveSteps } : {}) },
      backendUrl,
    );
    if (telemetry.taskId) setTraceInfo({ taskId: telemetry.taskId, backendUrl });

    const plane = createHttpPlane(() => Promise.resolve(backendUrl));
    const workspaceInfo = await plane.describe().catch(() => null);
    const workspace = workspaceInfo?.enabled ? { plane, root: workspaceInfo.root } : undefined;

    let selected = skill;
    let taskText = task;
    const slash = /^\/([a-z0-9-]+)\s+([\s\S]+)/i.exec(task.trim());
    if (slash && skills.some((s) => s.slug === slash[1])) {
      selected = slash[1]!;
      taskText = slash[2]!;
    }
    let preamble: string | undefined;
    let skillMaxSteps: number | undefined;
    if (selected) {
      try {
        const res = await fetch(`${backendUrl}/skills/${encodeURIComponent(selected)}`);
        if (res.ok) {
          const full = (await res.json()) as { name?: string; body?: string; defaults?: Record<string, string> };
          if (full.defaults?.model && !model) runProvider = { ...runProvider, model: full.defaults.model };
          if (full.defaults?.effort && !effort) runProvider = { ...runProvider, thinking: full.defaults.effort as Effort };
          if (full.defaults?.maxSteps) skillMaxSteps = Number(full.defaults.maxSteps);
          if (full.body) preamble = `SKILL "${full.name ?? selected}" - follow this workflow for the whole task:\n\n${full.body}`.slice(0, 8000);
        }
      } catch {
      }
    }
    if (context) {
      try {
        const res = await fetch(`${backendUrl}/contexts/${encodeURIComponent(context)}`);
        if (res.ok) {
          const full = (await res.json()) as { name?: string; body?: string };
          if (full.body) {
            const contextPreamble = `USER CONTEXT "${full.name ?? context}" - this task is about the user described below; apply these facts when searching, filtering, and writing:\n\n${full.body}`.slice(0, 8000);
            preamble = preamble ? `${preamble}\n\n---\n\n${contextPreamble}` : contextPreamble;
          }
        }
      } catch {
      }
    }
    const skillChat = (messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse> =>
      chatCompletion(runProvider, { messages, tools, maxTokens: 8192, signal: controller.signal });

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
        ...(effectiveSteps.length ? { steps: effectiveSteps } : {}),
        ...(preamble ? { preamble } : {}),
        ...(skillMaxSteps ? { maxSteps: skillMaxSteps } : {}),
        onStep: (step) => {
          setSteps((prev) => {
            const next = [...prev, step];
            onRunningChange({ stepCount: next.length, snippet: task.slice(0, 60) });
            return next;
          });
        },
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
      onRunningChange(null);
      abortRef.current = null;
      if (telemetry.taskId) setChatTaskId(telemetry.taskId);
      void (async () => {
        try {
          const res = await fetch(`${backendUrl}/tasks?limit=12`);
          if (res.ok) {
            const body = (await res.json()) as RecentTask[];
            if (Array.isArray(body)) setRecentTasks(body);
          }
        } catch {
        }
      })();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function resolveProvider(): Promise<{ backendUrl: string; provider: LlmProvider } | null> {
    const backendUrl = await getBackendUrl();
    const provider = await resolveActiveProvider(store, undefined, { url: backendUrl });
    if (!provider) {
      setError('no active llm provider - add one in settings first');
      return null;
    }
    let effective = provider;
    if (model) effective = { ...effective, model };
    if (effort) effective = { ...effective, thinking: effort as Effort };
    return { backendUrl, provider: effective };
  }

  async function plan() {
    setError(null);
    setResult(null);
    setSteps([]);
    const resolved = await resolveProvider();
    if (!resolved) return;
    setPlanning(true);
    onRunningChange({ stepCount: 0, snippet: `planning: ${task.slice(0, 50)}` });
    try {
      const plan = await planTask(
        task.trim(),
        {
          driver: createExtensionDriver(),
          chat: (messages, tools) => chatCompletion(resolved.provider, { messages, tools, maxTokens: 4096 }),
        },
        (rec) => setSteps((prev) => [...prev, { index: prev.length + 1, call: rec.call, detail: rec.detail, ok: rec.ok }]),
      );
      setStepsMode(true);
      setTaskSteps(plan);
      setInputOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
      onRunningChange(null);
    }
  }

  const effectiveSteps = stepsMode ? taskSteps.map((s) => s.trim()).filter(Boolean) : [];

  function setStepAt(i: number, value: string) {
    setTaskSteps((prev) => prev.map((s, j) => (j === i ? value : s)));
  }
  function removeStep(i: number) {
    setTaskSteps((prev) => prev.filter((_, j) => j !== i));
  }

  function reuseTask(id: number) {
    const t = recentTasks.find((x) => x.id === id);
    if (!t) return;
    setTask(t.taskText.trim());
    const steps = (t.steps ?? []).map((s) => s.trim()).filter(Boolean);
    setStepsMode(steps.length > 0);
    setTaskSteps(steps.length > 0 ? steps : ['']);
    setInputOpen(true);
  }

  async function sendChat() {
    if (!chatTaskId || !chatInput.trim()) return;
    setChatState('queueing…');
    try {
      const res = await fetch(`${await getBackendUrl()}/tasks/${chatTaskId}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: chatInput.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChatInput('');
      setChatState(`queued task #${chatTaskId} - it runs and finishes on its own`);
    } catch (e) {
      setChatState(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function killSelected() {
    if (!chatTaskId) return;
    if (!window.confirm(`kill task #${chatTaskId}? this reloads the extension and stops any in-flight run`)) return;
    setChatState(`killing task #${chatTaskId}…`);
    try {
      const res = await fetch(`${await getBackendUrl()}/tasks/${chatTaskId}/kill`, { method: 'POST' });
      const body = (await res.json()) as { stopped: boolean };
      setChatState(body.stopped ? `task #${chatTaskId} killed - reload requested` : `task #${chatTaskId} was not queued/running`);
    } catch (e) {
      setChatState(`failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className="runner">
      <button type="button" className="card-head" onClick={() => setInputOpen((v) => !v)} aria-expanded={inputOpen}>
        <span className="card-title">new task</span>
        <span className="card-summary">{running ? 'running…' : task.trim() ? task.trim().slice(0, 60) : stepsMode ? 'multi-step' : 'describe a task'}</span>
        <Chevron open={inputOpen} />
      </button>
      <Collapse open={inputOpen}>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="e.g. open hackernews.com, go to the first story and summarize it"
          rows={3}
          disabled={running}
        />

        {stepsMode && (
          <StepsEditor steps={taskSteps} running={running} onSet={setStepAt} onRemove={removeStep} onAdd={() => setTaskSteps((prev) => [...prev, ''])} />
        )}
      </Collapse>

      <div className="config-bar">
        {recentTasks.length > 0 && (
          <label className="config" title="reload a recent task's text and steps into the form">
            <span>reuse</span>
            <select value="" onChange={(e) => { if (e.target.value) reuseTask(Number(e.target.value)); }} disabled={running}>
              <option value="">recent…</option>
              {recentTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.id} · {t.status} · {t.taskText.trim().slice(0, 30)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="config" title="split the task into ordered steps the agent executes as its milestone plan - it decides HOW to do each">
          <span>steps</span>
          <select value={stepsMode ? 'steps' : ''} onChange={(e) => { setStepsMode(e.target.value === 'steps'); if (!taskSteps.length) setTaskSteps(['']); }} disabled={running}>
            <option value="">single</option>
            <option value="steps">multi-step</option>
          </select>
        </label>
        {skills.length > 0 && (
          <label className="config">
            <span>skill</span>
            <select value={skill} onChange={(e) => setSkill(e.target.value)} disabled={running} title={skills.find((s) => s.slug === skill)?.description ?? 'pick a skill'}>
              <option value="">none</option>
              {skills.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {contexts.length > 0 && (
          <label className="config">
            <span>context</span>
            <select value={context} onChange={(e) => setContext(e.target.value)} disabled={running} title="attach a saved profile as background facts for this task">
              <option value="">none</option>
              {contexts.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.slug} · {(c.bytes / 1024).toFixed(1)}k
                </option>
              ))}
            </select>
          </label>
        )}
        {modelOptions.length > 0 && (
          <label className="config">
            <span>model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running} title="model for this task (overrides the provider default)">
              <option value="">default</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        {effortOptions.length > 0 && (
          <label className="config">
            <span>effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={running} title="reasoning effort for this task">
              <option value="">default</option>
              {effortOptions.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="run-controls">
          <button className="primary" disabled={running || !task.trim()} onClick={run}>
            run
          </button>
          <button disabled={running || planning || !task.trim()} onClick={plan} title="inspect the current browser state first, then propose an editable milestone plan">
            {planning ? 'planning…' : 'plan'}
          </button>
          <button className="danger" disabled={!running} onClick={stop}>
            stop
          </button>
        </div>
      </div>

      {!running && usingProvider && <div className="muted small">using {usingProvider}</div>}

      {error && <div className="note err">{error}</div>}

      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.index} className={step.ok ? 'step' : 'step failed'}>
              <span className="step-idx">{step.index}</span>
              <span className="step-body">
                <span className="step-call">{step.call}</span>
                <span className="muted">{step.detail}</span>
                {step.thinking && (
                  <details className="step-thinking" open>
                    <summary>thinking</summary>
                    <pre>{step.thinking}</pre>
                  </details>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}

      {traceInfo && (
        <div className="muted small">
          trace: #{traceInfo.taskId} —{' '}
          <a href={`${traceInfo.backendUrl}/tasks/${traceInfo.taskId}/debug`} target="_blank" rel="noreferrer">
            open debug json
          </a>
        </div>
      )}

      <ChatSection
        recentTasks={recentTasks}
        chatTaskId={chatTaskId}
        chatInput={chatInput}
        chatState={chatState}
        open={chatOpen}
        running={running}
        onToggle={() => setChatOpen((v) => !v)}
        onPick={setChatTaskId}
        onInput={setChatInput}
        onSend={() => void sendChat()}
        onKill={() => void killSelected()}
      />

      {result && <ResultView result={result} />}
    </div>
  );
}
