import type { ChatMessage, ChatResponse, ToolDef } from '../../llm/chatClient';
import type { Driver } from '../../driver/types';
import type { LocalPlane } from '../../local/plane.types';

export interface StepRecord {
  thinking?: string;
  index: number;
  call: string;
  detail: string;
  ok: boolean;
}

export interface TaskResult {
  status: 'done' | 'failed' | 'stopped';
  summary?: string;
  data?: unknown;
  reason?: string;
  steps: StepRecord[];
}

export interface LoopTelemetry {
  observe(step: number, data: Record<string, unknown>): Promise<void>;
  llm(step: number, data: Record<string, unknown>): Promise<void>;
  action(step: number, data: Record<string, unknown>): Promise<void>;
  answer(step: number, data: Record<string, unknown>): Promise<void>;
}

export interface LoopDeps {
  driver: Driver;
  chat: (messages: ChatMessage[], tools: ToolDef[]) => Promise<ChatResponse>;
  askUser: (question: string, recommended?: string) => Promise<string | null>;
  subAgent?: (task: string, budget?: number) => Promise<string>;
  research?: boolean;
  tabBudget?: number;
  maxSubAgents?: number;
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: StepRecord) => void;
  telemetry?: LoopTelemetry;
  workspace?: { plane: LocalPlane; root: string };
  taskId?: number;
  steps?: string[];
  preamble?: string;
  history?: ChatMessage[];
  cleanupTabs?: boolean;
}
