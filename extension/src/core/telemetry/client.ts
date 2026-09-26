import { runTask } from '../agent/loop';
import { chatCompletion } from '../llm/chatClient';

export type TelemetryEventType = 'observation' | 'llm_call' | 'action' | 'user_answer';

export interface TelemetryEvent {
  type: TelemetryEventType;
  step: number;
  data: Record<string, unknown>;
}

export interface TaskTelemetry {
  taskId: number | null;
  observe(step: number, data: Record<string, unknown>): Promise<void>;
  llm(step: number, data: Record<string, unknown>): Promise<void>;
  action(step: number, data: Record<string, unknown>): Promise<void>;
  answer(step: number, data: Record<string, unknown>): Promise<void>;
  finish(status: string, summary: string | undefined, reason: string | undefined, stepCount: number): Promise<void>;
}

interface TaskMeta {
  taskText: string;
  product: string;
  model: string;
  effort: string;
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
}

// telemetry must never break a run: every call swallows its errors
export async function startTelemetry(meta: TaskMeta, backendUrl: string): Promise<TaskTelemetry> {
  let taskId: number | null = null;
  try {
    const res = await post(`${backendUrl}/tasks`, meta);
    if (res.ok) {
      const body = (await res.json()) as { id?: number };
      taskId = body.id ?? null;
    }
  } catch {
    taskId = null;
  }
  if (!taskId) return disabledTelemetry();
  return attachTelemetry(taskId, backendUrl);
}

const REMOTE_ANSWER = '(remote run: no user available - proceed autonomously, but never take irreversible actions like paying, submitting orders, deleting, or posting)';

// a remote run has no prompt() to block on: park the question in the backend
// (the panel polls for pending questions and prompts the user), wait up to
// ASK_WAIT_MS for the answer, then fall back to the autonomous default
const ASK_WAIT_MS = 120_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRemoteAsk(taskId: number, backendUrl: string): (question: string) => Promise<string> {
  return async (question: string) => {
    try {
      const res = await post(`${backendUrl}/tasks/${taskId}/ask`, { step: 0, question });
      const { id } = (await res.json()) as { id: number };
      const deadline = Date.now() + ASK_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(3000);
        const check = await fetch(`${backendUrl}/asks/${id}`, { signal: AbortSignal.timeout(4000) });
        if (!check.ok) break;
        const { answer } = (await check.json()) as { answer: string | null };
        if (answer !== null && answer !== undefined) return answer;
      }
    } catch {
      // unreachable backend - proceed autonomously
    }
    return REMOTE_ANSWER;
  };
}

// remote runs have no panel: ask_user parks the question in the backend and
// waits briefly for the user's answer before proceeding autonomously
export async function runRemoteTask(
  taskId: number,
  taskText: string,
  backendUrl: string,
  deps: {
    provider: import('../llm/providers').LlmProvider;
    driver: import('../driver/types').Driver;
    signal?: AbortSignal;
    maxSteps?: number;
    workspace?: { plane: import('../local/plane').LocalPlane; root: string };
    preamble?: string;
    steps?: string[];
  },
): Promise<void> {
  const telemetry = attachTelemetry(taskId, backendUrl);
  try {
    await post(`${backendUrl}/tasks/${taskId}/start`, {
      product: deps.provider.productId,
      model: deps.provider.model,
      effort: deps.provider.thinking ?? 'off',
    });
  } catch {
    // start marker is best-effort
  }

  let result: Awaited<ReturnType<typeof runTask>> | null = null;
  try {
    result = await runTask(taskText, {
      driver: deps.driver,
      chat: (messages, tools) =>
        chatCompletion(deps.provider, { messages, tools, maxTokens: 8192, ...(deps.signal ? { signal: deps.signal } : {}) }),
      askUser: makeRemoteAsk(taskId, backendUrl),
      ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.workspace ? { workspace: deps.workspace } : {}),
      ...(deps.preamble ? { preamble: deps.preamble } : {}),
      ...(deps.steps?.length ? { steps: deps.steps } : {}),
      taskId,
      telemetry,
    });
  } catch (error) {
    // a crashed loop must not leave the row running forever - the reaper
    // would only resurrect it after a minute; fail it now with the reason
    const reason = `crashed: ${error instanceof Error ? error.message : String(error)}`;
    await telemetry.finish('failed', undefined, reason, 0);
    return;
  }
  await telemetry.finish(result.status, result.summary, result.reason, result.steps.length);
}

export function attachTelemetry(taskId: number, backendUrl: string): TaskTelemetry {
  const send = async (event: TelemetryEvent) => {
    try {
      await post(`${backendUrl}/tasks/${taskId}/events`, event);
    } catch {
      // dropped events are acceptable; debugging is best-effort
    }
  };

  return {
    taskId,
    observe: (step, data) => send({ type: 'observation', step, data }),
    llm: (step, data) => send({ type: 'llm_call', step, data }),
    action: (step, data) => send({ type: 'action', step, data }),
    answer: (step, data) => send({ type: 'user_answer', step, data }),
    finish: async (status, summary, reason, stepCount) => {
      try {
        await post(`${backendUrl}/tasks/${taskId}/finish`, { status, summary, reason, stepCount });
      } catch {
        // ignore
      }
    },
  };
}

function disabledTelemetry(): TaskTelemetry {
  return {
    taskId: null,
    observe: async () => {},
    llm: async () => {},
    action: async () => {},
    answer: async () => {},
    finish: async () => {},
  };
}
