import type { ChatMessage, ChatResponse, ToolDef } from '../llm/chatClient';
import type { Action, Driver, Snapshot } from '../driver/types';
import { parseCall, toolDefs } from './tools';
import { observationBlock, systemPrompt, taskContext } from './prompts';

export interface StepRecord {
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
  askUser: (question: string) => Promise<string | null>;
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: StepRecord) => void;
  telemetry?: LoopTelemetry;
}

const DEFAULT_MAX_STEPS = 60;
const LOOP_NUDGE_AT = 3;
const LOOP_BLOCK_AT = 5;
const STALL_LIMIT = 6;

const DANGER_PATTERN = /pay|purchase|order|buy|checkout|delete|remove|submit|post|send|confirm/i;

export function isDangerous(action: Action, snapshot: Snapshot | null): string | null {
  if (action.type !== 'click') return null;
  const el = snapshot?.elements.find((e) => e.ref === action.ref);
  if (el && DANGER_PATTERN.test(el.name)) return `click "${el.name.slice(0, 60)}"`;
  return null;
}

function normalizeUrlForCompare(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const params = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return raw;
  }
}

function actionKey(action: Action, snapshot: Snapshot | null): string {
  // page-state fingerprint must catch in-place UI changes (accordion expands,
  // tab switches, text appearing below the fold) or legitimate retries get
  // counted as loops
  const state = snapshot
    ? [
        snapshot.url,
        snapshot.title,
        snapshot.text.slice(0, 1500),
        snapshot.elements.map((el) => `${el.ref}:${el.expanded ?? ''}:${el.value ?? ''}`).join(','),
      ].join('|')
    : 'none';

  // goto/new_tab to the same url are the same navigation intent - alternating
  // between them must not evade repeat blocking
  if (action.type === 'goto') return `nav:${normalizeUrlForCompare(action.url)}|${state}`;
  if (action.type === 'new_tab') return `nav:${action.url ? normalizeUrlForCompare(action.url) : 'about:blank'}|${state}`;
  if (action.type === 'switch_tab' || action.type === 'close_tab') return `nav:tab:${action.tabId}|${state}`;
  // extract ignores the goal wording: re-asking the same page in different
  // words is the same no-op and must count toward blocking
  if (action.type === 'extract') return `extract|${state}`;
  return `${JSON.stringify(action)}|${state}`;
}

function describeAction(action: Action): string {
  switch (action.type) {
    case 'goto':
      return `goto ${action.url}`;
    case 'new_tab':
      return `new_tab ${action.url ?? '(blank)'}`;
    case 'switch_tab':
      return `switch_tab ${action.tabId}`;
    case 'close_tab':
      return `close_tab ${action.tabId}`;
    case 'click':
      return `click ${action.ref}`;
    case 'fill':
      return `fill ${action.ref} "${action.text.slice(0, 40)}"`;
    case 'select':
      return `select ${action.ref} "${action.option}"`;
    case 'press':
      return `press ${action.key}`;
    case 'scroll':
      return `scroll ${action.direction}${action.amount ? ` ${action.amount}` : ''}`;
    case 'wait':
      return `wait ${action.ms}ms`;
    case 'extract':
      return `extract "${action.goal.slice(0, 40)}"`;
  }
}

export async function runTask(task: string, deps: LoopDeps): Promise<TaskResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: StepRecord[] = [];
  const stepLines: string[] = [];
  const userAnswers: string[] = [];
  const extracts: Array<{ goal: string; text: string }> = [];
  const agentNotes: string[] = [];
  const repeatCounts = new Map<string, number>();
  const blockedKeys = new Set<string>();
  let consecutiveBlocked = 0;
  let notes: string[] = [];
  let noToolStrikes = 0;
  let index = 0;

  function record(ok: boolean, call: string, detail: string) {
    const step: StepRecord = { index: index + 1, call, detail, ok };
    steps.push(step);
    stepLines.push(ok ? `${step.call} → ${detail}` : `${step.call} → failed: ${detail}`);
    deps.onStep?.(step);
  }

  while (true) {
    if (deps.signal?.aborted) return { status: 'stopped', reason: 'cancelled by user', steps };
    if (index >= maxSteps) return { status: 'failed', reason: `step limit of ${maxSteps} reached`, steps };

    let tabs = [] as Awaited<ReturnType<Driver['tabs']>>;
    let snapshot: Snapshot | null = null;
    try {
      tabs = await deps.driver.tabs();
      snapshot = await deps.driver.snapshot();
    } catch {
      // no accessible page yet; the observation block reports that
    }
    await deps.telemetry?.observe(index + 1, {
      tabs,
      url: snapshot?.url ?? null,
      title: snapshot?.title ?? null,
      pageText: snapshot?.text ?? null,
      elements: snapshot?.elements ?? null,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: taskContext(task, stepLines, userAnswers, extracts, agentNotes) },
      ...notes.map((content) => ({ role: 'system' as const, content })),
      { role: 'user', content: observationBlock(tabs, snapshot) },
    ];
    notes = [];

    const remaining = maxSteps - index;
    if (remaining === 15 || remaining === 5) {
      messages.push({
        role: 'system',
        content: `Only ${remaining} steps left. Consolidate: finish verifying only your most promising remaining targets, then call done with the results you have (partial beats failing).`,
      });
    }

    let res: ChatResponse;
    const chatStarted = Date.now();
    try {
      res = await deps.chat(messages, toolDefs());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await deps.telemetry?.llm(index + 1, { messages, error: reason, durationMs: Date.now() - chatStarted });
      return { status: 'failed', reason: `llm error: ${reason}`, steps };
    }
    await deps.telemetry?.llm(index + 1, {
      messages,
      responseContent: res.content,
      toolCalls: res.toolCalls,
      usage: res.usage ?? null,
      durationMs: Date.now() - chatStarted,
    });

    if (res.toolCalls.length === 0) {
      noToolStrikes++;
      if (noToolStrikes >= 2) {
        return { status: 'failed', reason: `model stopped calling tools: ${res.content.slice(0, 200)}`, steps };
      }
      notes.push('You replied without calling a tool. You must call exactly one tool - done or fail if the task is finished or impossible.');
      continue;
    }
    noToolStrikes = 0;

    const call = res.toolCalls[0]!;
    const parsed = parseCall(call.name, call.args);
    if (!parsed.ok) {
      record(false, call.name, parsed.error);
      index++;
      continue;
    }

    const agentCall = parsed.call;
    if (agentCall.kind === 'done') {
      return { status: 'done', summary: agentCall.summary, ...(agentCall.data !== undefined ? { data: agentCall.data } : {}), steps };
    }
    if (agentCall.kind === 'fail') {
      return { status: 'failed', reason: agentCall.reason, steps };
    }
    if (agentCall.kind === 'ask_user') {
      const answer = await deps.askUser(agentCall.question);
      if (answer === null) return { status: 'stopped', reason: 'user dismissed the question', steps };
      userAnswers.push(`question: ${agentCall.question}\nanswer: ${answer}`);
      await deps.telemetry?.answer(index + 1, { question: agentCall.question, answer });
      record(true, 'ask_user', `"${agentCall.question}" → "${answer}"`);
      index++;
      continue;
    }
    if (agentCall.kind === 'observe') {
      record(true, call.name, 'fresh observation taken');
      index++;
      continue;
    }
    if (agentCall.kind === 'note') {
      agentNotes.push(agentCall.text);
      record(true, 'note', agentCall.text.slice(0, 90));
      index++;
      continue;
    }

    const action = agentCall.action;
    const danger = isDangerous(action, snapshot);
    if (danger) {
      const answer = await deps.askUser(`Allow web-robot to ${danger}? (yes/no)`);
      if (answer === null) return { status: 'stopped', reason: 'user dismissed the confirmation', steps };
      if (!/^\s*(y|yes|ok|allow)\b/i.test(answer)) {
        record(false, describeAction(action), `user declined ${danger}`);
        index++;
        continue;
      }
    }

    const key = actionKey(action, snapshot);
    if (blockedKeys.has(key)) {
      consecutiveBlocked++;
      record(false, describeAction(action), 'blocked: same action already repeated with no page change');
      notes.push('That exact action is blocked on this unchanged page (it did nothing last time). Pick a different element, scroll, extract, or continue with the rest of the task elsewhere.');
      index++;
      if (consecutiveBlocked >= STALL_LIMIT) {
        return { status: 'failed', reason: `stalled: ${consecutiveBlocked} consecutive chosen actions are all blocked no-ops`, steps };
      }
      continue;
    }
    consecutiveBlocked = 0;
    const seen = (repeatCounts.get(key) ?? 0) + 1;
    repeatCounts.set(key, seen);
    if (seen === LOOP_NUDGE_AT) {
      notes.push('The last actions changed nothing on the page. The element may be a no-op - pick a different element, scroll, or use extract to read more of the page.');
    }
    if (seen >= LOOP_BLOCK_AT) {
      blockedKeys.add(key);
      record(false, describeAction(action), `blocked after ${seen} identical attempts with no page change`);
      notes.push('Repeated no-op action is now blocked. This sub-target is a dead end - move on to the next candidate or a different approach instead of retrying.');
      index++;
      continue;
    }

    const actionStarted = Date.now();
    const result = await deps.driver.act(action);
    await deps.telemetry?.action(index + 1, {
      tool: action.type,
      args: action,
      ok: result.ok,
      detail: result.detail,
      durationMs: Date.now() - actionStarted,
    });
    if (result.ok && action.type === 'extract') {
      const text = result.detail;
      extracts.push({ goal: action.goal, text });
      record(true, describeAction(action), `${text.length} chars extracted`);
    } else {
      record(result.ok, describeAction(action), result.detail);
    }
    index++;
  }
}
