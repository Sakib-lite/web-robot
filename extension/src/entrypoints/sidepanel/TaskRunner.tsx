import { useRef, useState } from 'react';
import { runTask, type StepRecord, type TaskResult } from '@/core/agent/loop';
import { createExtensionDriver } from '@/core/driver/extensionDriver';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolDef } from '@/core/llm/chatClient';
import { resolveActiveProvider, type ProductStore } from '@/core/llm/providers';
import { getBackendUrl } from '@/core/telemetry/settings';
import { startTelemetry } from '@/core/telemetry/client';
import ResultView from './ResultView';

export default function TaskRunner({ store }: { store: ProductStore }) {
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingProvider, setUsingProvider] = useState<string | null>(null);
  const [traceInfo, setTraceInfo] = useState<{ taskId: string; backendUrl: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      chatCompletion(provider, { messages, tools, maxTokens: 4096, signal: controller.signal });

    const askUser = async (question: string) => window.prompt(`web-robot asks:\n${question}`);

    const backendUrl = await getBackendUrl();
    const telemetry = await startTelemetry(
      { taskText: task, product: provider.productId, model: provider.model, effort: provider.thinking ?? 'off' },
      backendUrl,
    );
    if (telemetry.taskId) setTraceInfo({ taskId: telemetry.taskId, backendUrl });

    let taskResult: TaskResult | null = null;
    try {
      taskResult = await runTask(task, {
        driver: createExtensionDriver(),
        chat,
        askUser,
        signal: controller.signal,
        telemetry,
        onStep: (step) => setSteps((prev) => [...prev, step]),
      });
      setResult(taskResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      const status = taskResult?.status ?? (controller.signal.aborted ? 'stopped' : 'failed');
      await telemetry.finish(status, taskResult?.summary, taskResult?.reason, taskResult?.steps.length ?? 0);
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
