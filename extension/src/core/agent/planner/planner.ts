import type { Driver, Snapshot, TabInfo } from '../../driver/types';
import type { ChatMessage, ChatResponse, ToolDef } from '../../llm/chatClient';
import { observationBlock } from '../prompts/prompts';
import { toolDefs } from '../tools/tools';
import { INSPECT_TOOLS, PROPOSE_PLAN, planItems, planSystemPrompt, toAction } from './planner.helper';

export interface PlanStepRecord {
  call: string;
  detail: string;
  ok: boolean;
}

export async function planTask(
  task: string,
  deps: { driver: Driver; chat: (messages: ChatMessage[], tools: ToolDef[]) => Promise<ChatResponse> },
  onStep?: (step: PlanStepRecord) => void,
  maxSteps = 8,
): Promise<string[]> {
  const tools: ToolDef[] = [...toolDefs({ workspace: false }).filter((t) => INSPECT_TOOLS.has(t.name)), PROPOSE_PLAN];
  const record = (call: string, detail: string, ok = true) => onStep?.({ call, detail, ok });
  let elementSkip = 0;
  let tabs: TabInfo[] = [];
  let snap: Snapshot | null = null;
  let lastStateKey = '';
  let idleSteps = 0;

  const observe = async () => {
    tabs = await deps.driver.tabs().catch(() => []);
    snap = await deps.driver.snapshot(elementSkip).catch(() => null);
  };
  const fallbackPlan = (): string[] => {
    const current = snap as Snapshot | null;
    const where = current?.url ? ` at ${current.url}` : '';
    return [
      `Open and survey the relevant page${where}`,
      `Work through the task step by step: ${task.slice(0, 140)}`,
      'Verify completeness (counts, full list, paged through all pages) and write the deliverable file(s) with full details',
    ];
  };
  const finish = async (force: boolean): Promise<string[]> => {
    if (!force) return [];
    await observe();
    const res = await deps.chat(
      [
        { role: 'system', content: planSystemPrompt(maxSteps) },
        { role: 'user', content: `TASK:\n${task}` },
        { role: 'user', content: observationBlock(tabs, snap) },
        { role: 'user', content: 'Inspection budget is spent. Call propose_plan NOW with 3-8 milestone items. Do not reply with anything else.' },
      ],
      [PROPOSE_PLAN],
    );
    const items = planItems(res);
    if (items.length) return items;
    record('propose_plan', 'model returned no usable plan - using a fallback draft you can edit', false);
    return fallbackPlan();
  };

  for (let step = 0; step < maxSteps; step++) {
    await observe();
    const current = snap as Snapshot | null;
    const stateKey = `${current?.url ?? ''}|${current?.title ?? ''}|${current?.text?.slice(0, 300) ?? ''}|${current?.elementStart ?? 0}`;
    if (stateKey === lastStateKey) {
      idleSteps++;
      if (idleSteps >= 2) {
        record('planner', 'inspection is not learning anything new - moving to the plan', false);
        return finish(true);
      }
    } else {
      idleSteps = 0;
      lastStateKey = stateKey;
    }
    const remaining = maxSteps - step;
    const res = await deps.chat(
      [
        { role: 'system', content: planSystemPrompt(maxSteps) + (remaining <= 3 ? ` BUDGET: only ${remaining} inspection steps left - call propose_plan NOW.` : '') },
        { role: 'user', content: `TASK:\n${task}` },
        { role: 'user', content: observationBlock(tabs, snap) },
      ],
      tools,
    );
    const call = res.toolCalls[0];
    if (!call) {
      record('reply', 'no tool call - expecting an inspection action or propose_plan', false);
      continue;
    }
    if (call.name === 'propose_plan') {
      const items = planItems(res);
      if (items.length) return items;
      record('propose_plan', 'empty plan items - retrying', false);
      continue;
    }
    if (!INSPECT_TOOLS.has(call.name)) {
      record(call.name, 'skipped: planning is read-only', false);
      continue;
    }
    if (call.name === 'snapshot') {
      elementSkip = call.args.skip !== undefined ? Math.max(0, Number(call.args.skip)) : 0;
      record('snapshot', call.args.skip !== undefined ? `observation window from element ${elementSkip + 1}` : 'fresh observation');
      continue;
    }
    const action = toAction(call.name, call.args);
    if (!action) {
      record(call.name, 'skipped: missing arguments', false);
      continue;
    }
    const result = await deps.driver.act(action);
    if (result.ok && (action.type === 'goto' || action.type === 'new_tab' || action.type === 'switch_tab')) elementSkip = 0;
    record(`${call.name} ${Object.values(call.args).join(' ')}`.trim().slice(0, 60), result.detail, result.ok);
  }
  return finish(true);
}
