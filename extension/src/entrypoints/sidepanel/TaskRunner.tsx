import { useEffect, useMemo, useRef, useState } from 'react';
import { runTask, type StepRecord, type TaskResult } from '@/core/agent/loop';
import { planTask } from '@/core/agent/planner';
import { makeSubAgent } from '@/core/agent/subagent';
import { createExtensionDriver } from '@/core/driver/extensionDriver';
import { createHttpPlane } from '@/core/local/httpPlane';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolDef } from '@/core/llm/chatClient';
import { resolveActiveProvider, type LlmProvider, type ProductStore, type StoredProductConfig } from '@/core/llm/providers';
import { getProduct, catalogModels, type Effort, type ProductId } from '@/core/llm/products';
import { getBackendUrl } from '@/core/telemetry/settings';
import { Chevron, Collapse } from './common/ui';
import { StepsEditor } from './StepsEditor';
import { Transcript, type ChatMessageRow, type RecentTask } from './ChatSection';
import { startTelemetry } from '@/core/telemetry/client';
import { polishPrompt } from '@/core/agent/polish';
import PromptPolisher from './PromptPolisher';

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
  const [chatState, setChatState] = useState<string | null>(null);
  const [chatReload, setChatReload] = useState(0);
  const [backendUrlState, setBackendUrlState] = useState('');
  const [awaitingReply, setAwaitingReply] = useState(false);
  const sentAtRef = useRef(0);
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

    let selected = skill;
    let taskText = task;
    const slash = /^\/([a-z0-9-]+)\s+([\s\S]+)/i.exec(task.trim());
    if (slash && skills.some((s) => s.slug === slash[1])) {
      selected = slash[1]!;
      taskText = slash[2]!;
    }

    const telemetry = await startTelemetry(
      { taskText: task, ...(selected ? { skill: selected } : {}), product: runProvider.productId, model: runProvider.model, effort: runProvider.thinking ?? 'off', ...(effectiveSteps.length ? { steps: effectiveSteps } : {}) },
      backendUrl,
    );
    if (telemetry.taskId) setTraceInfo({ taskId: telemetry.taskId, backendUrl });

    setBackendUrlState(backendUrl);
    const plane = createHttpPlane(() => Promise.resolve(backendUrl));
    const workspaceInfo = await plane.describe().catch(() => null);
    const workspace = workspaceInfo?.enabled ? { plane, root: workspaceInfo.root } : undefined;

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

    const pushStep = (step: StepRecord) => {
      setSteps((prev) => {
        const next = [...prev, step];
        onRunningChange({ stepCount: next.length, snippet: task.slice(0, 60) });
        return next;
      });
    };

    let taskResult: TaskResult | null = null;
    try {
      taskResult = await runTask(taskText, {
        driver: createExtensionDriver(),
        chat: skillChat,
        askUser,
        signal: controller.signal,
        telemetry,
        subAgent: makeSubAgent({
          makeDriver: createExtensionDriver,
          chat: skillChat,
          telemetry,
          signal: controller.signal,
          onStep: pushStep,
          ...(workspace && telemetry.taskId ? { workspace: { plane: workspace.plane, taskId: telemetry.taskId } } : {}),
        }),
        ...(workspace ? { workspace } : {}),
        ...(telemetry.taskId ? { taskId: telemetry.taskId } : {}),
        ...(effectiveSteps.length ? { steps: effectiveSteps } : {}),
        ...(preamble ? { preamble } : {}),
        ...(skillMaxSteps ? { maxSteps: skillMaxSteps } : {}),
        onStep: pushStep,
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
      setChatReload((k) => k + 1);
      setAwaitingReply(false);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
      onRunningChange(null);
    }
  }

  const effectiveSteps = stepsMode ? taskSteps.map((s) => s.trim()).filter(Boolean) : [];
  const activeTask = recentTasks.find((t) => t.id === chatTaskId);

  function setStepAt(i: number, value: string) {
    setTaskSteps((prev) => prev.map((s, j) => (j === i ? value : s)));
  }
  function removeStep(i: number) {
    setTaskSteps((prev) => prev.filter((_, j) => j !== i));
  }

  function openConversation(id: number) {
    setChatTaskId(id);
    setTask('');
    setSteps([]);
    setResult(null);
    setChatState(null);
    setAwaitingReply(false);
    setChatReload((k) => k + 1);
  }

  function newConversation() {
    setChatTaskId('');
    setTask('');
    setSteps([]);
    setResult(null);
    setChatState(null);
    setAwaitingReply(false);
  }

  function send() {
    const message = task.trim();
    if (!message) return;
    setTask('');
    if (chatTaskId) {
      void sendChat(message);
    } else {
      void run();
    }
  }

  async function sendChat(message: string) {
    if (!chatTaskId || !message.trim()) return;
    sentAtRef.current = Date.now();
    setAwaitingReply(true);
    setTask('');
    setChatState('sending…');
    try {
      const res = await fetch(`${await getBackendUrl()}/tasks/${chatTaskId}/continue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChatReload((k) => k + 1);
      setChatState(`queued #${chatTaskId} - the agent keeps the full conversation and replies here`);
    } catch (e) {
      setAwaitingReply(false);
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

  useEffect(() => {
    if (!awaitingReply || !chatTaskId) return;
    const timer = setInterval(() => setChatReload((k) => k + 1), 4000);
    return () => clearInterval(timer);
  }, [awaitingReply, chatTaskId]);

  useEffect(() => {
    if (!awaitingReply || !chatTaskId) return;
    let alive = true;
    const base = backendUrlState || 'http://127.0.0.1:3010';
    const poll = async () => {
      try {
        const res = await fetch(`${base}/tasks/${chatTaskId}/live`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const body = (await res.json()) as {
          actions?: Array<{ step: number; tool: string; detail: string; ok: boolean }>;
          calls?: Array<{ step: number; thinking: string | null }>;
        };
        if (!alive || !Array.isArray(body.actions) || body.actions.length === 0) return;
        const thinkingByStep = new Map<number, string>();
        for (const c of body.calls ?? []) {
          if (c.thinking && !thinkingByStep.has(c.step)) thinkingByStep.set(c.step, c.thinking);
        }
        const all = body.actions;
        const lastStart = all.map((a) => a.step).lastIndexOf(1);
        const current = lastStart >= 0 ? all.slice(lastStart) : all;
        setSteps(
          current.map((a) => ({
            index: a.step,
            call: a.tool,
            detail: a.detail,
            ok: a.ok,
            ...(thinkingByStep.get(a.step) ? { thinking: thinkingByStep.get(a.step)!.slice(0, 2000) } : {}),
          })),
        );
      } catch {
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [awaitingReply, chatTaskId, backendUrlState]);

  function handleLatest(message: ChatMessageRow | null) {
    if (!awaitingReply) return;
    if (message && message.role === 'agent' && new Date(message.createdAt).getTime() > sentAtRef.current) {
      setAwaitingReply(false);
      return;
    }
    if (['failed', 'stopped'].includes(activeTask?.status ?? '')) setAwaitingReply(false);
  }

  return (
    <div className="runner conv">
      <div className="conv-head">
        <span className={`conv-status ${(running || awaitingReply) ? 'on' : ''}`}>
          {chatTaskId ? `#${chatTaskId}` : 'new'} · {running ? 'running' : awaitingReply ? 'waiting' : chatTaskId ? (activeTask?.status ?? '') : 'chat'}
        </span>
        {recentTasks.length > 0 && (
          <select
            className="conv-open"
            value={chatTaskId === '' ? '' : chatTaskId}
            onChange={(e) => { if (e.target.value) openConversation(Number(e.target.value)); }}
            disabled={running}
            title="open a recent conversation with its full history"
          >
            <option value="">open…</option>
            {recentTasks.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.id} · {t.status} · {t.taskText.trim().slice(0, 24)}
              </option>
            ))}
          </select>
        )}
        <div className="conv-actions">
          {chatTaskId !== '' && (
            <a className="muted small" href={`${backendUrlState || 'http://127.0.0.1:3010'}/tasks/${chatTaskId}/debug`} target="_blank" rel="noreferrer">
              debug
            </a>
          )}
          {chatTaskId !== '' && (
            <button className="small-btn" onClick={() => void killSelected()} title="stop this task and reload the extension">
              kill
            </button>
          )}
          <button className="small-btn" disabled={running} onClick={newConversation} title="start a fresh conversation">
            new chat
          </button>
        </div>
      </div>

      <details className="settings-block">
        <summary>
          <span className="msg-role">config</span>
          <span className="muted small">
            {model || 'default model'} · {effort || 'default effort'}
            {chatTaskId === '' && skill ? ` · ${skill}` : ''}
            {chatTaskId === '' && context ? ` · ${context}` : ''}
            {chatTaskId === '' && stepsMode ? ' · multi-step' : ''}
          </span>
        </summary>
        <div className="config-bar">
          {chatTaskId === '' && (
            <label className="config" title="split the task into ordered steps the agent executes as its milestone plan">
              <span>steps</span>
              <select value={stepsMode ? 'steps' : ''} onChange={(e) => { setStepsMode(e.target.value === 'steps'); if (!taskSteps.length) setTaskSteps(['']); }} disabled={running}>
                <option value="">single</option>
                <option value="steps">multi-step</option>
              </select>
            </label>
          )}
          {chatTaskId === '' && skills.length > 0 && (
            <label className="config">
              <span>skill</span>
              <select value={skill} onChange={(e) => setSkill(e.target.value)} disabled={running} title={skills.find((x) => x.slug === skill)?.description ?? 'pick a skill'}>
                <option value="">none</option>
                {skills.map((x) => (
                  <option key={x.slug} value={x.slug}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chatTaskId === '' && contexts.length > 0 && (
            <label className="config">
              <span>context</span>
              <select value={context} onChange={(e) => setContext(e.target.value)} disabled={running} title="attach a saved profile as background facts">
                <option value="">none</option>
                {contexts.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.slug} · {(c.bytes / 1024).toFixed(1)}k
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="config">
            <span>model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running || !!chatTaskId} title="model for the first task of this conversation">
              <option value="">default</option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="config">
            <span>effort</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={running || !!chatTaskId} title="reasoning effort for this conversation">
              <option value="">default</option>
              {effortOptions.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          {chatTaskId === '' && (
            <button disabled={running || planning || !task.trim()} onClick={plan} title="inspect the browser first, then propose an editable milestone plan">
              {planning ? 'planning…' : 'plan'}
            </button>
          )}
        </div>
        {chatTaskId === '' && stepsMode && (
          <StepsEditor steps={taskSteps} running={running} onSet={setStepAt} onRemove={removeStep} onAdd={() => setTaskSteps((prev) => [...prev, ''])} />
        )}
        <PromptPolisher
          disabled={running}
          polish={async (input) => {
            const resolved = await resolveProvider();
            if (!resolved) throw new Error('no active llm provider - add one in settings first');
            return polishPrompt(input, resolved.provider);
          }}
          onUse={(p) => setTask(p)}
        />
      </details>

      <div className="chat-scroll">
        <Transcript
          taskId={chatTaskId}
          backendUrl={backendUrlState || 'http://127.0.0.1:3010'}
          reloadKey={chatReload}
          onLatest={handleLatest}
        />

        {steps.length > 0 && (
          <details className="run-block" open={running || awaitingReply}>
            <summary>
              <span className="msg-role">run · {steps.length} step{steps.length === 1 ? '' : 's'}</span>
            </summary>
            <ol className="steps">
              {steps.map((step) => (
                <li key={step.index} className={step.ok ? 'step' : 'step failed'}>
                  <details className="step-details">
                    <summary>
                      <span className="step-idx">{step.index}</span>
                      <span className="step-call">{step.call}</span>
                      {!step.ok && <span className="muted"> ✗</span>}
                    </summary>
                    <span className="step-body">
                      <span className="muted">{step.detail}</span>
                      {step.thinking && (
                        <details className="step-thinking">
                          <summary>thinking</summary>
                          <pre>{step.thinking}</pre>
                        </details>
                      )}
                    </span>
                  </details>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      {error && <div className="note err">{error}</div>}
      {chatState && <div className="muted small">{chatState}</div>}

      <div className="composer">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={chatTaskId ? `message #${chatTaskId} - it remembers everything (Cmd+Enter)` : 'describe a task to start a conversation (Cmd+Enter)'}
          rows={chatTaskId ? 2 : 3}
          disabled={running}
        />
        {running ? (
          <button className="danger" onClick={stop}>
            stop
          </button>
        ) : (
          <button className="primary" disabled={!task.trim() || planning} onClick={send}>
            {chatTaskId ? 'send' : 'run'}
          </button>
        )}
      </div>
    </div>
  );
}
