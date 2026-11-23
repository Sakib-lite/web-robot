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
