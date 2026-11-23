import { toolSpecs } from './tools';
import type { AgentCall, LocalCall, ToolSpec } from './tools.types';

export function describeLocal(call: LocalCall): string {
  switch (call.op) {
    case 'fetch_url':
      return `fetch_url ${call.url.slice(0, 70)}`;
    case 'search_web':
      return `search_web "${call.query.slice(0, 50)}"`;
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

const PLAN_TEXT_KEYS = ['text', 'step', 'name', 'title', 'description', 'item', 'label', 'task', 'milestone', 'content', 'message', 'summary', 'plan'] as const;

export function normalizePlanArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.items)) return args;
  const items = args.items
    .map((item) => {
      if (typeof item === 'string') return { text: item };
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.text === 'string' && rec.text.trim()) return rec;
        const keyed = PLAN_TEXT_KEYS.map((k) => rec[k]).find((v) => typeof v === 'string' && v.trim());
        if (typeof keyed === 'string') return { ...rec, text: keyed };
        const anyString = Object.values(rec).find((v) => typeof v === 'string' && v.trim());
        if (typeof anyString === 'string') return { ...rec, text: anyString };
      }
      return null;
    })
    .filter((it): it is { text: string } => it !== null);
  return { ...args, items };
}

export function parseCall(name: string, args: Record<string, unknown>): { ok: true; call: AgentCall } | { ok: false; error: string } {
  const spec = (toolSpecs as Record<string, ToolSpec | undefined>)[name];
  if (!spec) return { ok: false, error: `unknown tool: ${name}` };
  const validated = spec.schema.safeParse(name === 'update_plan' ? normalizePlanArgs(args) : args);
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
      return { ok: true, call: { kind: 'action', action: { type: 'click', ref: String(a.ref), ...(a.trusted !== undefined ? { trusted: a.trusted === true } : {}) } } };
    case 'click_at':
      return { ok: true, call: { kind: 'action', action: { type: 'click_at', x: Number(a.x), y: Number(a.y) } } };
    case 'hover':
      return { ok: true, call: { kind: 'action', action: { type: 'hover', ref: String(a.ref) } } };
    case 'fill':
      return { ok: true, call: { kind: 'action', action: { type: 'fill', ref: String(a.ref), text: String(a.text) } } };
    case 'select':
      return { ok: true, call: { kind: 'action', action: { type: 'select', ref: String(a.ref), option: String(a.option) } } };
    case 'press':
      return {
        ok: true,
        call: {
          kind: 'action',
          action: { type: 'press', key: String(a.key), ...(Array.isArray(a.modifiers) ? { modifiers: a.modifiers.map(String) } : {}) },
        },
      };
    case 'evaluate_js':
      return {
        ok: true,
        call: {
          kind: 'action',
          action: { type: 'evaluate_js', expression: String(a.expression), ...(a.await_promise !== undefined ? { awaitPromise: a.await_promise === true } : {}) },
        },
      };
    case 'screenshot':
      return {
        ok: true,
        call: {
          kind: 'action',
          action: {
            type: 'screenshot',
            ...(a.full_page !== undefined ? { fullPage: a.full_page === true } : {}),
            ...(a.format !== undefined ? { format: a.format === 'png' ? ('png' as const) : ('jpeg' as const) } : {}),
            ...(a.max_width !== undefined ? { maxWidth: Number(a.max_width) } : {}),
          },
        },
      };
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
      return { ok: true, call: { kind: 'observe', ...(a.skip !== undefined ? { skip: Number(a.skip) } : {}) } };
    case 'fetch_url':
      return { ok: true, call: { kind: 'local', call: { op: 'fetch_url', url: String(a.url) } } };
    case 'search_web':
      return { ok: true, call: { kind: 'local', call: { op: 'search_web', query: String(a.query) } } };
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
    case 'sub_agent':
      return {
        ok: true,
        call: { kind: 'sub_agent', task: String(a.task), ...(a.budget !== undefined ? { budget: Number(a.budget) } : {}) },
      };
    case 'note':
      return { ok: true, call: { kind: 'note', text: String(a.text) } };
    case 'ask_user':
      return { ok: true, call: { kind: 'ask_user', question: String(a.question), ...(a.recommended !== undefined ? { recommended: String(a.recommended) } : {}) } };
    case 'done':
      return { ok: true, call: { kind: 'done', summary: String(a.summary), ...(a.data !== undefined ? { data: a.data } : {}) } };
    case 'fail':
      return { ok: true, call: { kind: 'fail', reason: String(a.reason) } };
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}
