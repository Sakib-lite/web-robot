import { useEffect, useMemo, useRef, useState } from 'react';
import { runTask, type StepRecord, type TaskResult } from '@/core/agent/loop';
import { createExtensionDriver } from '@/core/driver/extensionDriver';
import { createHttpPlane } from '@/core/local/httpPlane';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolDef } from '@/core/llm/chatClient';
import { resolveActiveProvider, type ProductStore, type StoredProductConfig } from '@/core/llm/providers';
import { getProduct, type Effort } from '@/core/llm/products';
import { getBackendUrl } from '@/core/telemetry/settings';
import { Chevron, Collapse } from './SettingsView';
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
  onRunningChange,
}: {
  store: ProductStore;
  configs: StoredProductConfig[] | null;
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
  const [recentTasks, setRecentTasks] = useState<Array<{ id: number; taskText: string; status: string }>>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [running, setRunning] = useState(false);
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
  const modelOptions = activeProduct?.models ?? [];
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
          const body = (await tasksRes.json()) as Array<{ id: number; taskText: string; status: string }>;
          setRecentTasks(Array.isArray(body) ? body : []);
          const finished = Array.isArray(body) ? body.find((t) => t.status !== 'queued' && t.status !== 'running') : undefined;
          if (finished) setChatTaskId(finished.id);
        }
      } catch {
        // backend down - dropdowns just stay empty
      }
    })();
  }, []);

  async function run() {
    setError(null);
    setResult(null);
    setSteps([]);
    setTraceInfo(null);

    const askUser = async (question: string) => window.prompt(`web-robot asks:\n${question}`);

    const backendUrl = await getBackendUrl();

    // db (backend) is the canonical provider store; falls back to chrome.storage when unreachable
    const provider = await resolveActiveProvider(store, undefined, { url: backendUrl });
    if (!provider) {
      setError('no active llm provider - add one in settings first');
      return;
    }

    setRunning(true);
    onRunningChange({ stepCount: 0, snippet: task.slice(0, 60) });
    const controller = new AbortController();
    abortRef.current = controller;

    // per-task model/effort picked in the config bar win; a selected skill
    // fills only what was not chosen explicitly
    let runProvider = provider;
    if (model) runProvider = { ...runProvider, model };
    if (effort) runProvider = { ...runProvider, thinking: effort as Effort };
    setUsingProvider(`${runProvider.productId} · ${runProvider.model} · ${runProvider.thinking ?? 'off'}`);

    const telemetry = await startTelemetry(
      { taskText: task, product: runProvider.productId, model: runProvider.model, effort: runProvider.thinking ?? 'off' },
      backendUrl,
    );
    if (telemetry.taskId) setTraceInfo({ taskId: telemetry.taskId, backendUrl });

    // local workspace hands, when the backend offers them
    const plane = createHttpPlane(() => Promise.resolve(backendUrl));
    const workspaceInfo = await plane.describe().catch(() => null);
    const workspace = workspaceInfo?.enabled ? { plane, root: workspaceInfo.root } : undefined;

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
        // missing skill runs without the preamble
      }
    }
    // an attached context (a shared profile etc.) rides along as facts for
    // the whole task - same injection as the queue-worker path
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
        // missing context runs without the preamble
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
      // the finished task becomes the chat target; recent list refreshes
      if (telemetry.taskId) setChatTaskId(telemetry.taskId);
      void (async () => {
        try {
          const res = await fetch(`${backendUrl}/tasks?limit=12`);
          if (res.ok) {
            const body = (await res.json()) as Array<{ id: number; taskText: string; status: string }>;
            if (Array.isArray(body)) setRecentTasks(body);
          }
        } catch {
          // best-effort
        }
      })();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const effectiveSteps = stepsMode ? taskSteps.map((s) => s.trim()).filter(Boolean) : [];

  function setStepAt(i: number, value: string) {
    setTaskSteps((prev) => prev.map((s, j) => (j === i ? value : s)));
  }
  function removeStep(i: number) {
    setTaskSteps((prev) => prev.filter((_, j) => j !== i));
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
          <div className="steps-editor">
            {taskSteps.map((s, i) => (
              <div key={i} className="step-row">
                <span className="step-n">{i + 1}</span>
                <input
                  value={s}
                  onChange={(e) => setStepAt(i, e.target.value)}
                  placeholder={`step ${i + 1} - e.g. ${i === 0 ? 'check all posts, list every uni in unis.md' : i === 1 ? 'write ielts-requirements.md per uni' : 'verify both files'}`}
                  disabled={running}
                />
                <button className="icon-btn" onClick={() => removeStep(i)} disabled={running || taskSteps.length === 1} title="remove step">
                  ×
                </button>
              </div>
            ))}
            <button className="ghost" onClick={() => setTaskSteps((prev) => [...prev, ''])} disabled={running}>
              + add step
            </button>
          </div>
        )}
      </Collapse>

      <div className="config-bar">
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

      {recentTasks.length > 0 && (
        <div className="chat-section">
          <button type="button" className="card-head" onClick={() => setChatOpen((v) => !v)} aria-expanded={chatOpen}>
            <span className="card-title">chat / continue a task</span>
            <span className="card-summary">{chatTaskId ? `#${chatTaskId} selected` : `${recentTasks.length} recent`}</span>
            <Chevron open={chatOpen} />
          </button>
          <Collapse open={chatOpen}>
            <div className="chat-bar">
              <div className="row">
                <select value={chatTaskId} onChange={(e) => setChatTaskId(e.target.value ? Number(e.target.value) : '')} disabled={running}>
                  {chatTaskId === '' && <option value="">pick task…</option>}
                  {recentTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} · {t.status} · {t.taskText.slice(0, 40)}
                    </option>
                  ))}
                </select>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendChat();
                  }}
                  placeholder={chatTaskId ? `message task #${chatTaskId} - e.g. check how many docker containers are running` : 'pick a task above first'}
                  disabled={running || !chatTaskId}
                />
                <button className="primary" onClick={() => void sendChat()} disabled={running || !chatTaskId || !chatInput.trim()}>
                  send
                </button>
                <button className="danger" onClick={() => void killSelected()} disabled={!chatTaskId} title="mark this task stopped and reload the extension - stops any in-flight run">
                  kill
                </button>
              </div>
              {chatState && <div className="muted small">{chatState}</div>}
            </div>
          </Collapse>
        </div>
      )}

      {result && <ResultView result={result} />}
    </div>
  );
}
