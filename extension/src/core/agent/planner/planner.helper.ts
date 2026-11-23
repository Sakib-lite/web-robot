import type { Action } from '../../driver/types';
import type { ChatResponse, ToolDef } from '../../llm/chatClient';
import { normalizePlanArgs } from '../tools/calls.helper';

export const INSPECT_TOOLS = new Set(['goto', 'new_tab', 'switch_tab', 'close_tab', 'snapshot', 'extract', 'wait', 'scroll']);

export const PROPOSE_PLAN: ToolDef = {
  name: 'propose_plan',
  description: 'Submit the final milestone plan for the task: 3-8 concrete, ordered steps describing WHAT must exist at the end (not how to drive the browser). This is your final answer.',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', minItems: 1, items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
    required: ['items'],
  },
};

export function planSystemPrompt(maxSteps: number): string {
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

export function toAction(name: string, args: Record<string, unknown>): Action | null {
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

export function planItems(res: ChatResponse): string[] {
  const raw = res.toolCalls.find((c) => c.name === 'propose_plan');
  const source = raw ? raw.args.items : itemsFromContent(res.content);
  if (source === null || source === undefined) return [];
  const normalized = normalizePlanArgs({ items: source });
  return (Array.isArray(normalized.items) ? normalized.items : [])
    .map((item) => String((item as { text?: unknown }).text ?? '').replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}
