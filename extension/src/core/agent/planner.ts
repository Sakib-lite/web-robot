import type { Action, Driver, Snapshot, TabInfo } from '../driver/types';
import type { ChatMessage, ChatResponse, ToolDef } from '../llm/chatClient';
import { observationBlock } from './prompts';
import { normalizePlanArgs, toolDefs } from './tools';

export interface PlanStepRecord {
  call: string;
  detail: string;
  ok: boolean;
}

const INSPECT_TOOLS = new Set(['goto', 'new_tab', 'switch_tab', 'close_tab', 'snapshot', 'extract', 'wait', 'scroll']);

const PROPOSE_PLAN: ToolDef = {
  name: 'propose_plan',
  description: 'Submit the final milestone plan for the task: 3-8 concrete, ordered steps describing WHAT must exist at the end (not how to drive the browser). This is your final answer.',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', minItems: 1, items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
    required: ['items'],
  },
};

function planSystemPrompt(maxSteps: number): string {
  return [
    'You are the planning stage of web-robot. The user gave a task; before it runs, you inspect the browser and produce the milestone plan the runner agent will follow.',
    `Rules:`,
    `1. INSPECT first: goto/new_tab/switch_tab to the relevant site, snapshot to read elements (snapshot takes skip to page through long lists), extract to read text. You have up to ${maxSteps} inspection steps - spend them on seeing exactly what the task will operate on (counts, list shape, relevant pages).`,
    '2. READ-ONLY: you look, you never touch. click/fill/select/press and all file/exec tools are unavailable.',
    '3. Call snapshot at most once per page state - repeating snapshot on an unchanged page teaches you nothing. Prefer goto to a relevant page or extract to read text.',
    '4. When you know enough (or the budget is nearly spent), call propose_plan with 3-8 items: concrete ordered milestones with verifiable ends, e.g. "list all 48 universities in unis.md", not "click around".',
    '5. If the task names a site that is not open, goto it. If an element list is truncated, page through with snapshot skip=N before planning.',
    '6. propose_plan is your final answer and you MUST call it - a run that ends without proposing is a failed plan. If you are unsure, propose the best plan you can anyway; the user will edit it.',
  ].join('\n');
}

function toAction(name: string, args: Record<string, unknown>): Action | null {
  switch (name) {
    case 'goto':
      return { type: 'goto', url: String(args.url ?? '') };
    case 'new_tab':
      return { type: 'new_tab', ...(args.url !== undefined ? { url: String(args.url) } : {}) };
    case 'switch_tab':
      return { type: 'switch_tab', tabId: Number(args.tabId) };
    case 'close_tab':
      return { type: 'close_tab', tabId: Number(args.tabId) };
    case 'extract':
      return { type: 'extract', goal: String(args.goal ?? '') };
    case 'scroll':
      return { type: 'scroll', direction: args.direction === 'up' ? 'up' : 'down', ...(args.amount !== undefined ? { amount: Number(args.amount) } : {}) };
    case 'wait':
      return { type: 'wait', ms: Number(args.ms ?? 1000) };
    default:
      return null;
  }
}

function itemsFromContent(content: string): unknown[] | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { items?: unknown };
    return Array.isArray(parsed.items) ? parsed.items : null;
  } catch {
    return null;
  }
}

function planItems(res: ChatResponse): string[] {
  const raw = res.toolCalls.find((c) => c.name === 'propose_plan');
  const source = raw ? raw.args.items : itemsFromContent(res.content);
  if (source === null || source === undefined) return [];
  const normalized = normalizePlanArgs({ items: source });
  return (Array.isArray(normalized.items) ? normalized.items : [])
    .map((item) => String((item as { text?: unknown }).text ?? '').replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
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
