import { z } from 'zod';
import type { ToolDef } from '../llm/chatClient';
import type { Action } from '../driver/types';

export type AgentCall =
  | { kind: 'action'; action: Action }
  | { kind: 'observe' }
  | { kind: 'note'; text: string }
  | { kind: 'local'; call: LocalCall }
  | { kind: 'plan'; items: Array<{ text: string; done?: boolean }> }
  | { kind: 'ask_user'; question: string }
  | { kind: 'done'; summary: string; data?: unknown }
  | { kind: 'fail'; reason: string };

// the local workspace tools - present only when a LocalPlane is wired in
export type LocalCall =
  | { op: 'list_dir'; path?: string }
  | { op: 'read_file'; path: string; offset?: number; limit?: number }
  | { op: 'write_file'; path: string; content: string }
  | { op: 'edit_file'; path: string; oldString: string; newString: string; replaceAll?: boolean }
  | { op: 'append_file'; path: string; text: string }
  | { op: 'delete_path'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'exec'; cmd: string; timeoutMs?: number };

export function describeLocal(call: LocalCall): string {
  switch (call.op) {
    case 'list_dir':
      return `list_dir ${call.path ?? '.'}`;
    case 'read_file':
      return `read_file ${call.path}`;
    case 'write_file':
      return `write_file ${call.path}`;
    case 'edit_file':
      return `edit_file ${call.path}`;
    case 'append_file':
      return `append_file ${call.path}`;
    case 'delete_path':
      return `delete_path ${call.path}`;
    case 'mkdir':
      return `mkdir ${call.path}`;
    case 'exec':
      return `exec ${call.cmd.slice(0, 70)}`;
  }
}

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
  extract: { description: 'Read targeted information from the page. Returns the main content text; use it after each page of a listing task.', schema: z.object({ goal: z.string() }) },
  wait: { description: 'Wait before the next observation, at most 5000 ms.', schema: z.object({ ms: z.number().int().min(0).max(5000) }) },
  note: { description: 'Record a durable finding or plan update (e.g. "UIC: PTE 54 verified at mscs.uic.edu"). Notes stay visible for the rest of the task - use them as your working memory.', schema: z.object({ text: z.string() }) },
  snapshot: { description: 'Re-read the current page observation (tabs + elements).', schema: z.object({}) },
  ask_user: { description: 'Ask the user a question when blocked, or to confirm an irreversible action.', schema: z.object({ question: z.string() }) },
  done: { description: 'Finish the task with a summary written in markdown (use - bullets for lists, 1. numbering for ordered items, **bold** for key facts) and optional extracted data.', schema: z.object({ summary: z.string(), data: z.unknown().optional() }) },
  fail: { description: 'Give up on the task and explain why.', schema: z.object({ reason: z.string() }) },
  list_dir: { description: 'List a directory in your local workspace (path relative to the workspace root, default "."). Dirs first, with sizes and dates.', schema: z.object({ path: z.string().optional() }) },
  read_file: { description: 'Read numbered lines from a workspace file. Defaults to the first 300 lines; paginate with offset/limit. Always returns "lines X-Y of N" so you know what is left.', schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional() }) },
  write_file: { description: 'Create a new workspace file, or overwrite one you have read_file this task (blind overwrites are blocked). Parent folders are created automatically.', schema: z.object({ path: z.string(), content: z.string() }) },
  edit_file: { description: 'Replace an exact unique string in a file you have read_file this task. Returns the changed line number, not the file - much cheaper than rewriting.', schema: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }) },
  append_file: { description: 'Append text to a workspace file (creates it if missing). The cheap way to grow a report: append each verified batch instead of rewriting the whole file.', schema: z.object({ path: z.string(), text: z.string() }) },
  delete_path: { description: 'Delete a file or directory tree in the workspace.', schema: z.object({ path: z.string() }) },
  mkdir: { description: 'Create a workspace directory, with parents.', schema: z.object({ path: z.string() }) },
  exec: { description: 'Run a shell command inside the workspace (cwd = workspace root; a few catastrophic commands are blocked). Output comes back capped head+tail - pipe through head/tail/grep yourself for big listings.', schema: z.object({ cmd: z.string(), timeout_ms: z.number().int().optional() }) },
  update_plan: { description: 'Rewrite your milestone checklist for this task (3-6 concrete items). It is persisted to PLAN.md and survives interruptions - a resumed run continues from it. Call it at the start of a multi-step task and check items off as they complete.', schema: z.object({ items: z.array(z.object({ text: z.string(), done: z.boolean().optional() })).min(1) }) },
} satisfies Record<string, ToolSpec>;

const LOCAL_TOOLS = new Set(['list_dir', 'read_file', 'write_file', 'edit_file', 'append_file', 'delete_path', 'mkdir', 'exec', 'update_plan']);

export function toolDefs(opts: { workspace?: boolean } = {}): ToolDef[] {
  return Object.entries(toolSpecs)
    .filter(([name]) => opts.workspace || !LOCAL_TOOLS.has(name))
    .map(([name, spec]) => ({
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
      return { ok: true, call: { kind: 'action', action: { type: 'extract', goal: String(a.goal) } } };
    case 'snapshot':
      return { ok: true, call: { kind: 'observe' } };
    case 'list_dir':
      return { ok: true, call: { kind: 'local', call: { op: 'list_dir', ...(a.path !== undefined ? { path: String(a.path) } : {}) } } };
    case 'read_file':
      return {
        ok: true,
        call: {
          kind: 'local',
          call: {
            op: 'read_file',
            path: String(a.path),
            ...(a.offset !== undefined ? { offset: Number(a.offset) } : {}),
            ...(a.limit !== undefined ? { limit: Number(a.limit) } : {}),
          },
        },
      };
    case 'write_file':
      return { ok: true, call: { kind: 'local', call: { op: 'write_file', path: String(a.path), content: String(a.content) } } };
    case 'edit_file':
      return {
        ok: true,
        call: {
          kind: 'local',
          call: {
            op: 'edit_file',
            path: String(a.path),
            oldString: String(a.old_string),
            newString: String(a.new_string),
            ...(a.replace_all !== undefined ? { replaceAll: a.replace_all === true } : {}),
          },
        },
      };
    case 'append_file':
      return { ok: true, call: { kind: 'local', call: { op: 'append_file', path: String(a.path), text: String(a.text) } } };
    case 'delete_path':
      return { ok: true, call: { kind: 'local', call: { op: 'delete_path', path: String(a.path) } } };
    case 'mkdir':
      return { ok: true, call: { kind: 'local', call: { op: 'mkdir', path: String(a.path) } } };
    case 'exec':
      return {
        ok: true,
        call: { kind: 'local', call: { op: 'exec', cmd: String(a.cmd), ...(a.timeout_ms !== undefined ? { timeoutMs: Number(a.timeout_ms) } : {}) } },
      };
    case 'update_plan': {
      const items = (a.items as Array<Record<string, unknown>>).map((item) => ({
        text: String(item.text),
        ...(item.done !== undefined ? { done: item.done === true } : {}),
      }));
      return { ok: true, call: { kind: 'plan', items } };
    }
    case 'note':
      return { ok: true, call: { kind: 'note', text: String(a.text) } };
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
