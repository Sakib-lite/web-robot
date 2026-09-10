import { runTask } from '../agent/loop';
import { chatCompletion } from '../llm/chatClient';

export type TelemetryEventType = 'observation' | 'llm_call' | 'action' | 'user_answer';

export interface TelemetryEvent {
  type: TelemetryEventType;
  step: number;
  data: Record<string, unknown>;
}

export interface TaskTelemetry {
  taskId: string | null;
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
  let taskId: string | null = null;
  try {
    const res = await post(`${backendUrl}/tasks`, meta);
    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      taskId = body.id ?? null;
    }
  } catch {
    taskId = null;
  }
  if (!taskId) return disabledTelemetry();
  return attachTelemetry(taskId, backendUrl);
}

const REMOTE_ANSWER = '(remote run: no user available - proceed autonomously, but never take irreversible actions like paying, submitting orders, deleting, or posting)';

// remote runs have no panel: answer ask_user with guidance instead of blocking
export async function runRemoteTask(
  taskId: string,
  taskText: string,
  backendUrl: string,
  deps: {
    provider: import('../llm/providers').LlmProvider;
    driver: import('../driver/types').Driver;
    signal?: AbortSignal;
    maxSteps?: number;
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

  const result = await runTask(taskText, {
    driver: deps.driver,
    chat: (messages, tools) =>
      chatCompletion(deps.provider, { messages, tools, maxTokens: 8192, ...(deps.signal ? { signal: deps.signal } : {}) }),
    askUser: async () => REMOTE_ANSWER,
    ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    telemetry,
  });
  await telemetry.finish(result.status, result.summary, result.reason, result.steps.length);
}

export function attachTelemetry(taskId: string, backendUrl: string): TaskTelemetry {
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
