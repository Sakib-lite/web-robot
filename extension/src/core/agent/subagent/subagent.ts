import type { ChatMessage, ChatResponse, ToolDef } from '../../llm/chatClient';
import type { Driver } from '../../driver/types';
import type { LocalPlane } from '../../local/plane.types';
import { runTask, type LoopDeps, type StepRecord, type TaskResult } from '../loop/loop';

const DEFAULT_BUDGET = 16;
const MIN_BUDGET = 6;
const MAX_BUDGET = 30;
const MAX_DIGEST = 1500;

export interface SubAgentDeps {
  makeDriver: () => Driver;
  chat: (messages: ChatMessage[], tools: ToolDef[]) => Promise<ChatResponse>;
  telemetry?: LoopDeps['telemetry'];
  onStep?: (step: StepRecord) => void;
  signal?: AbortSignal;
  workspace?: { plane: LocalPlane; taskId: number };
}

export function makeSubAgent(deps: SubAgentDeps): (task: string, budget?: number) => Promise<string> {
  let n = 0;
  return async (task, budget) => {
    n += 1;
    const id = n;
    const steps = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, budget ?? DEFAULT_BUDGET));
    const result: TaskResult = await runTask(task, {
      driver: deps.makeDriver(),
      chat: deps.chat,
      askUser: async (_question, recommended) => recommended ?? null,
      maxSteps: steps,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
      ...(deps.onStep ? { onStep: (step) => deps.onStep?.({ ...step, call: `[s${id}] ${step.call}` }) } : {}),
      research: true,
      tabBudget: 2,
    });
    const text = digest(id, task, result);
    if (deps.workspace) {
      const head = task.replace(/\s+/g, ' ').slice(0, 70);
      try {
        await deps.workspace.plane.append(
          `.web-robot/tasks/${deps.workspace.taskId}/subagents.md`,
          `## sub-agent ${id} — ${head}\n${text}\n\n`,
        );
      } catch {
      }
    }
    return text;
  };
}

function digest(id: number, task: string, result: TaskResult): string {
  const head = task.replace(/\s+/g, ' ').slice(0, 70);
  const label = `sub-agent ${id} ("${head}")`;
  const body =
    result.status === 'done'
      ? `${label} done:\n${result.summary ?? ''}`
      : `${label} ${result.status}: ${result.reason ?? 'no reason'}`;
  return body.length > MAX_DIGEST ? `${body.slice(0, MAX_DIGEST)}…` : body;
}
