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

  const disabled: TaskTelemetry = {
    taskId: null,
    observe: async () => {},
    llm: async () => {},
    action: async () => {},
    answer: async () => {},
    finish: async () => {},
  };
  if (!taskId) return disabled;

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
