import { z } from 'zod';
import type { ToolDef } from '../../llm/chatClient';
import type { ToolSpec } from './tools.types';

export const toolSpecs = {
  goto: { description: 'Navigate the current tab to a URL.', schema: z.object({ url: z.string() }) },
  new_tab: { description: 'Open a new tab, optionally at a URL, and make it active.', schema: z.object({ url: z.string().optional() }) },
  switch_tab: { description: 'Switch to an open tab by its id (see the tab list in the observation).', schema: z.object({ tabId: z.number().int() }) },
  close_tab: { description: 'Close a tab by its id.', schema: z.object({ tabId: z.number().int() }) },
  click: { description: 'Click an element by its ref from the latest page observation. If the page ignores the click, the runtime automatically retries it once as a trusted (debugger) click.', schema: z.object({ ref: z.string(), trusted: z.boolean().optional() }) },
  click_at: { description: 'Click at viewport coordinates with trusted input - last resort when the element you need has no usable ref.', schema: z.object({ x: z.number(), y: z.number() }) },
  hover: { description: 'Move the mouse over an element by ref (trusted) - reveals hover menus and tooltips.', schema: z.object({ ref: z.string() }) },
  fill: { description: 'Replace the text of an input or textarea by ref.', schema: z.object({ ref: z.string(), text: z.string() }) },
  select: { description: 'Choose an option of a select dropdown by ref.', schema: z.object({ ref: z.string(), option: z.string() }) },
  press: { description: 'Press a key on the focused element, e.g. Enter or Escape - sent as trusted input, so Enter actually submits forms.', schema: z.object({ key: z.string(), modifiers: z.array(z.enum(['alt', 'control', 'meta', 'shift'])).optional() }) },
  evaluate_js: { description: 'Run JavaScript inside the page (page context, bypasses its CSP). Use it to read data the page computes - window state, JSON blobs, fetch() results - or to act through the page\'s own code. Returns the JSON result.', schema: z.object({ expression: z.string().min(1), await_promise: z.boolean().optional() }) },
  screenshot: { description: 'Capture the page as an image saved to your task folder under screenshots/ (full_page for the whole page). Use it when the element tree is confusing or the page state should be visible to a human.', schema: z.object({ full_page: z.boolean().optional(), format: z.enum(['jpeg', 'png']).optional(), max_width: z.number().int().min(100).max(4096).optional() }) },
  scroll: { description: 'Scroll the page up or down.', schema: z.object({ direction: z.enum(['up', 'down']), amount: z.number().int().optional() }) },
  extract: { description: 'Read targeted information from the page. Returns the main content text; use it after each page of a listing task.', schema: z.object({ goal: z.string() }) },
  wait: { description: 'Wait before the next observation, at most 5000 ms.', schema: z.object({ ms: z.number().int().min(0).max(5000) }) },
  note: { description: 'Record a durable finding or plan update (e.g. "UIC: PTE 54 verified at mscs.uic.edu"). Notes stay visible for the rest of the task - use them as your working memory.', schema: z.object({ text: z.string() }) },
  snapshot: { description: 'Re-read the current page observation. Use skip to page through a long element list: if the header says "showing 1-80 of 200", call with skip=80 for the next page; refs from other pages stay clickable.', schema: z.object({ skip: z.number().int().min(0).optional() }) },
  ask_user: { description: 'Ask the user a question when blocked, or to confirm an irreversible action. ALWAYS include your recommended default in recommended - after 30s without an answer the runtime applies it automatically and continues.', schema: z.object({ question: z.string(), recommended: z.string().optional() }) },
  done: { description: 'Finish the task with a summary written in markdown (use - bullets for lists, 1. numbering for ordered items, **bold** for key facts) and optional extracted data.', schema: z.object({ summary: z.string(), data: z.unknown().optional() }) },
  fail: { description: 'Give up on the task and explain why.', schema: z.object({ reason: z.string() }) },
  list_dir: { description: 'List a directory in your local workspace (path relative to the workspace root, default "."). Dirs first, with sizes and dates.', schema: z.object({ path: z.string().optional() }) },
  read_file: { description: 'Read numbered lines from a workspace file. Defaults to the first 300 lines; paginate with offset/limit. Always returns "lines X-Y of N" so you know what is left.', schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional() }) },
  write_file: { description: 'Create a new workspace file, or overwrite one you have read_file this task (blind overwrites are blocked). Parent folders are created automatically.', schema: z.object({ path: z.string(), content: z.string() }) },
  edit_file: { description: 'Replace an exact unique string in a file you have read_file this task. Returns the changed line number, not the file - much cheaper than rewriting.', schema: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }) },
  append_file: { description: 'Append text to a workspace file (creates it if missing). The cheap way to grow a report: append each verified batch instead of rewriting the whole file.', schema: z.object({ path: z.string(), text: z.string() }) },
  delete_path: { description: 'Delete a file or directory tree in the workspace.', schema: z.object({ path: z.string() }) },
  mkdir: { description: 'Create a workspace directory, with parents.', schema: z.object({ path: z.string() }) },
  fetch_url: { description: 'Fetch a public web page over http and return its readable text (no browser, no login) - the fast way to read a page. If it returns an empty shell or fails, the page needs JavaScript: then open it in the browser instead.', schema: z.object({ url: z.string().url() }) },
  search_web: { description: 'Search the web (DuckDuckGo) and return the top results with title, url and snippet. Use it to find pages, then fetch_url to read them - much faster than searching in the browser.', schema: z.object({ query: z.string().min(1) }) },
  exec: { description: 'Run a shell command inside the workspace (cwd = workspace root; a few catastrophic commands are blocked). Output comes back capped head+tail - pipe through head/tail/grep yourself for big listings.', schema: z.object({ cmd: z.string(), timeout_ms: z.number().int().optional() }) },
  sub_agent: { description: 'Run a one-item research sub-agent with a fresh context: give it exactly ONE item (one university, one query) plus any context it needs; it opens its own tab, browses read-only and returns a digest with source urls. Use it for per-item research when the task has many similar items; a single lookup or one exec script is faster done yourself.', schema: z.object({ task: z.string().min(1), budget: z.number().int().min(6).max(30).optional() }) },
} satisfies Record<string, ToolSpec>;

const LOCAL_TOOLS = new Set(['fetch_url', 'search_web', 'list_dir', 'read_file', 'write_file', 'edit_file', 'append_file', 'delete_path', 'mkdir', 'exec']);

const RESEARCH_TOOLS = new Set(['goto', 'new_tab', 'switch_tab', 'close_tab', 'click', 'fill', 'select', 'press', 'scroll', 'extract', 'wait', 'snapshot', 'fetch_url', 'search_web', 'note', 'done', 'fail']);

export function toolDefs(opts: { workspace?: boolean; subAgent?: boolean; research?: boolean } = {}): ToolDef[] {
  return Object.entries(toolSpecs)
    .filter(([name]) => (opts.workspace || !LOCAL_TOOLS.has(name)) && (!opts.research || RESEARCH_TOOLS.has(name)) && (opts.subAgent || name !== 'sub_agent'))
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
