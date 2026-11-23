import { Action } from './entities/action.entity';
import { LlmCall } from './entities/llm-call.entity';
import { Observation } from './entities/observation.entity';
import { Task } from './entities/task.entity';
import { UserAnswer } from './entities/user-answer.entity';
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
    skill: string | null;
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

export interface TaskTrace {
  task: Task;
  observations: Observation[];
  llmCalls: LlmCall[];
  actions: Action[];
  userAnswers: UserAnswer[];
}

export function buildDebugReport(trace: TaskTrace): DebugReport {
  const timeline: TimelineEntry[] = [
    ...trace.observations.map((row) => ({
      step: row.step,
      type: 'observation' as const,
      at: row.createdAt.toISOString(),
      data: { url: row.url, title: row.title, pageText: row.pageText, elements: row.elements, tabs: row.tabs },
    })),
    ...trace.llmCalls.map((row) => ({
      step: row.step,
      type: 'llm_call' as const,
      at: row.createdAt.toISOString(),
      data: {
        messages: row.messages,
        responseContent: row.responseContent,
        toolCalls: row.toolCalls,
        usage: row.usage,
        durationMs: row.durationMs,
        error: row.error,
      },
    })),
    ...trace.actions.map((row) => ({
      step: row.step,
      type: 'action' as const,
      at: row.createdAt.toISOString(),
      data: { tool: row.tool, args: row.args, ok: row.ok, detail: row.detail, durationMs: row.durationMs },
    })),
    ...trace.userAnswers.map((row) => ({
      step: row.step,
      type: 'user_answer' as const,
      at: row.createdAt.toISOString(),
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
    failures.push({ step: trace.task.stepCount, kind: `task_${trace.task.status}`, what: trace.task.reason });
  }

  return {
    task: {
      id: trace.task.id,
      taskText: trace.task.taskText,
      skill: trace.task.skill,
      status: trace.task.status,
      summary: trace.task.summary,
      reason: trace.task.reason,
      product: trace.task.product,
      model: trace.task.model,
      effort: trace.task.effort,
      stepCount: trace.task.stepCount,
      createdAt: trace.task.createdAt.toISOString(),
      finishedAt: trace.task.finishedAt?.toISOString() ?? null,
    },
    timeline,
    failures,
  };
}
