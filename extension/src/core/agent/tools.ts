import { z } from 'zod';
import type { ToolDef } from '../llm/chatClient';
import type { Action } from '../driver/types';

export type AgentCall =
  | { kind: 'action'; action: Action }
  | { kind: 'observe' }
  | { kind: 'ask_user'; question: string }
  | { kind: 'done'; summary: string; data?: unknown }
  | { kind: 'fail'; reason: string };

interface ToolSpec {
  description: string;
  schema: z.ZodType;
}

export const toolSpecs = {
  goto: { description: 'Navigate the current tab to a URL.', schema: z.object({ url: z.string() }) },
  new_tab: { description: 'Open a new tab, optionally at a URL, and make it active.', schema: z.object({ url: z.string().optional() }) },
  switch_tab: { description: 'Switch to an open tab by its id (see the tab list in the observation).', schema: z.object({ tabId: z.number().int() }) },
  close_tab: { description: 'Close a tab by its id.', schema: z.object({ tabId: z.number().int() }) },
  click: { description: 'Click an element by its ref from the latest page observation.', schema: z.object({ ref: z.string() }) },
  fill: { description: 'Replace the text of an input or textarea by ref.', schema: z.object({ ref: z.string(), text: z.string() }) },
  select: { description: 'Choose an option of a select dropdown by ref.', schema: z.object({ ref: z.string(), option: z.string() }) },
  press: { description: 'Press a key on the focused element, e.g. Enter or Escape.', schema: z.object({ key: z.string() }) },
  scroll: { description: 'Scroll the page up or down.', schema: z.object({ direction: z.enum(['up', 'down']), amount: z.number().int().optional() }) },
  extract: { description: 'Read targeted information from the page. Prefer this over dump-style reading.', schema: z.object({ goal: z.string() }) },
  wait: { description: 'Wait before the next observation, at most 5000 ms.', schema: z.object({ ms: z.number().int().min(0).max(5000) }) },
  snapshot: { description: 'Re-read the current page observation (tabs + elements).', schema: z.object({}) },
  ask_user: { description: 'Ask the user a question when blocked, or to confirm an irreversible action.', schema: z.object({ question: z.string() }) },
  done: { description: 'Finish the task with a summary and optional extracted data.', schema: z.object({ summary: z.string(), data: z.unknown().optional() }) },
  fail: { description: 'Give up on the task and explain why.', schema: z.object({ reason: z.string() }) },
} satisfies Record<string, ToolSpec>;

export function toolDefs(): ToolDef[] {
  return Object.entries(toolSpecs).map(([name, spec]) => ({
    name,
    description: spec.description,
    parameters: jsonSchema(spec.schema),
  }));
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const parsed = z.toJSONSchema(schema) as Record<string, unknown>;
  delete parsed.$schema;
  return parsed;
}

export function parseCall(name: string, args: Record<string, unknown>): { ok: true; call: AgentCall } | { ok: false; error: string } {
  const spec = (toolSpecs as Record<string, ToolSpec | undefined>)[name];
  if (!spec) return { ok: false, error: `unknown tool: ${name}` };
  const validated = spec.schema.safeParse(args);
  if (!validated.success) return { ok: false, error: `invalid arguments for ${name}: ${validated.error.message}` };

  const a = validated.data as Record<string, unknown>;
  switch (name) {
    case 'goto':
      return { ok: true, call: { kind: 'action', action: { type: 'goto', url: String(a.url) } } };
    case 'new_tab':
      return { ok: true, call: { kind: 'action', action: { type: 'new_tab', ...(a.url ? { url: String(a.url) } : {}) } } };
    case 'switch_tab':
      return { ok: true, call: { kind: 'action', action: { type: 'switch_tab', tabId: Number(a.tabId) } } };
    case 'close_tab':
      return { ok: true, call: { kind: 'action', action: { type: 'close_tab', tabId: Number(a.tabId) } } };
    case 'click':
      return { ok: true, call: { kind: 'action', action: { type: 'click', ref: String(a.ref) } } };
    case 'fill':
      return { ok: true, call: { kind: 'action', action: { type: 'fill', ref: String(a.ref), text: String(a.text) } } };
    case 'select':
      return { ok: true, call: { kind: 'action', action: { type: 'select', ref: String(a.ref), option: String(a.option) } } };
    case 'press':
      return { ok: true, call: { kind: 'action', action: { type: 'press', key: String(a.key) } } };
    case 'scroll':
      return {
        ok: true,
        call: {
          kind: 'action',
          action: { type: 'scroll', direction: a.direction === 'up' ? 'up' : 'down', ...(a.amount !== undefined ? { amount: Number(a.amount) } : {}) },
        },
      };
    case 'wait':
      return { ok: true, call: { kind: 'action', action: { type: 'wait', ms: Number(a.ms) } } };
    case 'extract':
    case 'snapshot':
      return { ok: true, call: { kind: 'observe' } };
    case 'ask_user':
      return { ok: true, call: { kind: 'ask_user', question: String(a.question) } };
    case 'done':
      return { ok: true, call: { kind: 'done', summary: String(a.summary), ...(a.data !== undefined ? { data: a.data } : {}) } };
    case 'fail':
      return { ok: true, call: { kind: 'fail', reason: String(a.reason) } };
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}
