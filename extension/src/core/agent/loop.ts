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

export interface LoopDeps {
  driver: Driver;
  chat: (messages: ChatMessage[], tools: ToolDef[]) => Promise<ChatResponse>;
  askUser: (question: string) => Promise<string | null>;
  maxSteps?: number;
  signal?: AbortSignal;
  onStep?: (step: StepRecord) => void;
}

const DEFAULT_MAX_STEPS = 40;
const LOOP_NUDGE_AT = 3;
const LOOP_FAIL_AT = 5;

const DANGER_PATTERN = /pay|purchase|order|buy|checkout|delete|remove|submit|post|send|confirm/i;

export function isDangerous(action: Action, snapshot: Snapshot | null): string | null {
  if (action.type !== 'click') return null;
  const el = snapshot?.elements.find((e) => e.ref === action.ref);
  if (el && DANGER_PATTERN.test(el.name)) return `click "${el.name.slice(0, 60)}"`;
  return null;
}

function actionKey(action: Action, snapshot: Snapshot | null): string {
  const state = snapshot ? `${snapshot.url}|${snapshot.title}|${snapshot.elements.length}|${snapshot.text.slice(0, 200)}` : 'none';
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
  }
}

export async function runTask(task: string, deps: LoopDeps): Promise<TaskResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: StepRecord[] = [];
  const stepLines: string[] = [];
  const userAnswers: string[] = [];
  const repeatCounts = new Map<string, number>();
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

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: taskContext(task, stepLines, userAnswers) },
      ...notes.map((content) => ({ role: 'system' as const, content })),
      { role: 'user', content: observationBlock(tabs, snapshot) },
    ];
    notes = [];

    let res: ChatResponse;
    try {
      res = await deps.chat(messages, toolDefs());
    } catch (error) {
      return { status: 'failed', reason: `llm error: ${error instanceof Error ? error.message : String(error)}`, steps };
    }

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
      record(true, 'ask_user', `"${agentCall.question}" → "${answer}"`);
      index++;
      continue;
    }
    if (agentCall.kind === 'observe') {
      record(true, call.name, 'fresh observation taken');
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
    const seen = (repeatCounts.get(key) ?? 0) + 1;
    repeatCounts.set(key, seen);
    if (seen === LOOP_NUDGE_AT) {
      notes.push('You repeated the same action without the page changing. Choose a different approach.');
    }
    if (seen >= LOOP_FAIL_AT) {
      return { status: 'failed', reason: `loop detected: ${describeAction(action)} repeated ${seen} times without page change`, steps };
    }

    const result = await deps.driver.act(action);
    record(result.ok, describeAction(action), result.detail);
    index++;
  }
}
