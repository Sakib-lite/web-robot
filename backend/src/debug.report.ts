export interface TimelineEntry {
  step: number;
  type: 'observation' | 'llm_call' | 'action' | 'user_answer';
  at: string;
  data: Record<string, unknown>;
}

export interface DebugReport {
  task: {
    id: number;
    taskText: string;
    status: string;
    summary: string | null;
    reason: string | null;
    product: string | null;
    model: string | null;
    effort: string | null;
    stepCount: number;
    createdAt: string;
    finishedAt: string | null;
  };
  timeline: TimelineEntry[];
  failures: Array<{ step: number; kind: string; what: string }>;
}

interface TaskRow {
  id: number;
  task_text: string;
  status: string;
  summary: string | null;
  reason: string | null;
  product: string | null;
  model: string | null;
  effort: string | null;
  step_count: number;
  created_at: Date;
  finished_at: Date | null;
}

interface ObservationRow {
  step: number;
  url: string | null;
  title: string | null;
  page_text: string | null;
  elements: unknown;
  tabs: unknown;
  created_at: Date;
}

interface LlmRow {
  step: number;
  messages: unknown;
  response_content: string | null;
  tool_calls: unknown;
  usage: unknown;
  duration_ms: number | null;
  error: string | null;
  created_at: Date;
}

interface ActionRow {
  step: number;
  tool: string;
  args: unknown;
  ok: boolean;
  detail: string | null;
  duration_ms: number | null;
  created_at: Date;
}

interface AnswerRow {
  step: number;
  question: string;
  answer: string | null;
  created_at: Date;
}

export interface TaskTrace {
  task: TaskRow;
  observations: ObservationRow[];
  llmCalls: LlmRow[];
  actions: ActionRow[];
  userAnswers: AnswerRow[];
}

export function buildDebugReport(trace: TaskTrace): DebugReport {
  const timeline: TimelineEntry[] = [
    ...trace.observations.map((row) => ({
      step: row.step,
      type: 'observation' as const,
      at: row.created_at.toISOString(),
      data: { url: row.url, title: row.title, pageText: row.page_text, elements: row.elements, tabs: row.tabs },
    })),
    ...trace.llmCalls.map((row) => ({
      step: row.step,
      type: 'llm_call' as const,
      at: row.created_at.toISOString(),
      data: {
        messages: row.messages,
        responseContent: row.response_content,
        toolCalls: row.tool_calls,
        usage: row.usage,
        durationMs: row.duration_ms,
        error: row.error,
      },
    })),
    ...trace.actions.map((row) => ({
      step: row.step,
      type: 'action' as const,
      at: row.created_at.toISOString(),
      data: { tool: row.tool, args: row.args, ok: row.ok, detail: row.detail, durationMs: row.duration_ms },
    })),
    ...trace.userAnswers.map((row) => ({
      step: row.step,
      type: 'user_answer' as const,
      at: row.created_at.toISOString(),
      data: { question: row.question, answer: row.answer },
    })),
  ].sort((a, b) => (a.step - b.step) || a.at.localeCompare(b.at));

  const failures: DebugReport['failures'] = [];
  for (const action of trace.actions.filter((row) => !row.ok)) {
    failures.push({ step: action.step, kind: 'action_failed', what: `${action.tool}: ${action.detail ?? 'no detail'}` });
  }
  for (const call of trace.llmCalls.filter((row) => row.error)) {
    failures.push({ step: call.step, kind: 'llm_error', what: call.error ?? 'unknown llm error' });
  }
  if (trace.task.reason) {
    failures.push({ step: trace.task.step_count, kind: `task_${trace.task.status}`, what: trace.task.reason });
  }

  return {
    task: {
      id: trace.task.id,
      taskText: trace.task.task_text,
      status: trace.task.status,
      summary: trace.task.summary,
      reason: trace.task.reason,
      product: trace.task.product,
      model: trace.task.model,
      effort: trace.task.effort,
      stepCount: trace.task.step_count,
      createdAt: trace.task.created_at.toISOString(),
      finishedAt: trace.task.finished_at?.toISOString() ?? null,
    },
    timeline,
    failures,
  };
}
