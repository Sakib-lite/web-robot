import type { ChatMessage, ChatResponse, ToolDef } from '../llm/chatClient';
import type { Action, Driver, Snapshot } from '../driver/types';
import type { LocalPlane } from '../local/plane';
import { runLocal, type LocalOutcome } from './runLocal';
import { PlaneError } from '../local/plane';
import { describeLocal, parseCall, toolDefs, type LocalCall } from './tools';
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
  workspace?: { plane: LocalPlane; root: string };
  taskId?: number;
  steps?: string[];
  preamble?: string;
  cleanupTabs?: boolean;
}

const DEFAULT_MAX_STEPS = 400;
const LOOP_NUDGE_AT = 3;
const LOOP_BLOCK_AT = 5;
const STALL_LIMIT = 6;

const DANGER_PATTERN = /pay|purchase|order|buy|checkout|delete|remove|submit|post|send|confirm/i;

const MAX_LOCAL_CONTEXT = 12000;
const TAB_BUDGET = 6;
const EXEC_TOTAL_SOFT = 40;
const FILE_OPS_NUDGE = 20;
const FILE_OPS_BLOCK = 35;

function execSpiralGuard(
  call: LocalCall,
  execCount: { total: number },
  fileOps: Map<string, number>,
  notes: string[],
): 'ok' | 'blocked' {
  const targets = new Set<string>();
  if ('path' in call && typeof call.path === 'string') targets.add(call.path);
  if (call.op === 'exec') {
    execCount.total++;
    for (const token of call.cmd.match(/[\w./-]+\.(?:txt|html?|md|json|csv|tsv|xml)\b/gi) ?? []) targets.add(token.toLowerCase());
  }
  for (const target of targets) {
    const seen = (fileOps.get(target) ?? 0) + 1;
    fileOps.set(target, seen);
    if (seen === FILE_OPS_NUDGE) {
      notes.push(
        `You have now run ${seen} commands against "${target}". Slicing a big file through exec burns a step per slice and earlier outputs are dropped from context. Instead: write ONE python script that parses "${target}" fully and writes the final structured output to a new file, then read_file that result once.`,
      );
    }
    if (seen >= FILE_OPS_BLOCK && call.op === 'exec') {
      notes.push(`"${target}" is fenced off: further exec touching it is blocked. Transform it with one script or use read_file.`);
      return 'blocked';
    }
  }
  if (execCount.total === EXEC_TOTAL_SOFT) {
    notes.push(
      `You have used ${execCount.total} exec calls. Each is a full agent step - consolidate all remaining parsing/transformation into as few scripts as possible and produce the deliverable now.`,
    );
  }
  return 'ok';
}

function agentNoteDetail(text: string): string {
  return text.length > 90 ? `${text.slice(0, 87)}… (saved to PLAN.md)` : `${text} (saved to PLAN.md)`;
}


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
  const state = snapshot
    ? [
        snapshot.url,
        snapshot.title,
        snapshot.text.slice(0, 1500),
        snapshot.text.length,
        snapshot.elements.map((el) => `${el.ref}:${el.expanded ?? ''}:${el.value ?? ''}`).join(','),
      ].join('|')
    : 'none';

  if (action.type === 'goto') return `nav:${normalizeUrlForCompare(action.url)}|${state}`;
  if (action.type === 'new_tab') return `nav:${action.url ? normalizeUrlForCompare(action.url) : 'about:blank'}|${state}`;
  if (action.type === 'switch_tab' || action.type === 'close_tab') return `nav:tab:${action.tabId}|${state}`;
  if (action.type === 'extract') return `extract|${action.goal.trim().toLowerCase().slice(0, 80)}|${state}`;
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
  let maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: StepRecord[] = [];
  const stepLines: string[] = [];
  const userAnswers: string[] = [];
  const extracts: Array<{ goal: string; text: string }> = [];
  const agentNotes: string[] = [];
  const seenPageStates = new Set<string>();
  const repeatCounts = new Map<string, number>();
  const extractsOnState = new Map<string, number>();
  let effectProbe: { call: string; key: string } | null = null;
  const blockedKeys = new Set<string>();
  const readLedger = new Set<string>();
  let latestLocal: { label: string; text: string } | null = null;
  const execCount = { total: 0 };
  const fileOps = new Map<string, number>();
  let execDigests: string[] = [];
  const taskDir = deps.taskId != null ? `.web-robot/tasks/${deps.taskId}` : null;
  const filesTouched = new Map<string, string>();
  const ownedTabs = new Map<number, string>();
  let consecutiveBlocked = 0;
  let elementSkip = 0;
  let execFailCmd = '';
  let execFailStreak = 0;
  const blockedExecCmds = new Set<string>();
  let notes: string[] = [];
  let noToolStrikes = 0;
  let consecutiveReads = 0;
  let index = 0;

  function record(ok: boolean, call: string, detail: string) {
    const step: StepRecord = { index: index + 1, call, detail, ok };
    steps.push(step);
    stepLines.push(ok ? `${step.call} → ${detail}` : `${step.call} → failed: ${detail}`);
    deps.onStep?.(step);
  }

  async function cleanupOwnedTabs() {
    if (deps.cleanupTabs === false || ownedTabs.size === 0) return;
    for (const tabId of [...ownedTabs.keys()]) {
      try {
        await deps.driver.act({ type: 'close_tab', tabId });
      } catch {
      }
    }
    ownedTabs.clear();
  }

  try {
  while (true) {
    if (deps.signal?.aborted) return { status: 'stopped', reason: 'cancelled by user', steps };
    if (index >= maxSteps) {
      return { status: 'failed', reason: `step limit of ${maxSteps} reached`, steps };
    }

    let tabs = [] as Awaited<ReturnType<Driver['tabs']>>;
    let snapshot: Snapshot | null = null;
    try {
      tabs = await deps.driver.tabs();
      snapshot = await deps.driver.snapshot(elementSkip);
      if (snapshot?.text) seenPageStates.add(snapshot.text.slice(0, 500));
      if (effectProbe && snapshot) {
        const nowKey = `${snapshot.url}|${snapshot.title}|${snapshot.text.length}|${snapshot.text.slice(0, 1500)}`;
        if (nowKey === effectProbe.key) {
          notes.push(`${effectProbe.call} had no visible effect on the page - the page state is identical. That element is a dead end; pick a different element or approach.`);
        }
        effectProbe = null;
      }
    } catch {
    }
    await deps.telemetry?.observe(index + 1, {
      tabs,
      url: snapshot?.url ?? null,
      title: snapshot?.title ?? null,
      pageText: snapshot?.text ?? null,
      elements: snapshot?.elements ?? null,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(deps.workspace?.root, taskDir ?? undefined) },
      ...(deps.preamble ? [{ role: 'system' as const, content: deps.preamble }] : []),
      ...(deps.steps?.length
        ? [{
            role: 'system' as const,
            content: `USER STEPS (execute in order):\n${deps.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
          }]
        : []),
      { role: 'user', content: taskContext(task, stepLines, userAnswers, extracts, agentNotes, latestLocal, execDigests) },
      ...notes.map((content) => ({ role: 'system' as const, content })),
      { role: 'user', content: observationBlock(tabs, snapshot, Object.fromEntries(ownedTabs)) },
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
      res = await deps.chat(messages, toolDefs({ workspace: !!deps.workspace }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await deps.telemetry?.llm(index + 1, { messages, error: reason, durationMs: Date.now() - chatStarted });
      if (deps.signal?.aborted) return { status: 'stopped', reason: 'cancelled by user', steps };
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
      const empty = !res.content.trim();
      const reason = `model stopped calling tools${empty ? ' (empty replies)' : ''}: ${res.content.slice(0, 200)}`;
      noToolStrikes++;
      if (noToolStrikes >= 3) {
        return { status: 'failed', reason, steps };
      }
      notes.push(
        empty
          ? 'Your last reply came back empty. Respond now by calling exactly one tool - done or fail if the task is finished or impossible. Never return a blank message.'
          : 'You replied without calling a tool. You must call exactly one tool - done or fail if the task is finished or impossible.',
      );
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
    const isRead = agentCall.kind === 'action' && agentCall.action.type === 'extract'
      || agentCall.kind === 'observe'
      || (agentCall.kind === 'local' && (agentCall.call.op === 'read_file' || agentCall.call.op === 'list_dir'));
    if (isRead && consecutiveReads >= 3) {
      record(false, call.name, 'blocked: three read-only calls in a row without acting - ACT NOW (click a row, select, goto, write/append a file, or done)');
      notes.push('READS ARE BLOCKED until you act. You have only observed. Your next call must change something: click the next item, select an option, goto a page, or append_file your findings. Do not call extract, snapshot, read_file or list_dir again.');
      consecutiveBlocked++;
      if (consecutiveBlocked >= STALL_LIMIT) {
        return { status: 'failed', reason: 'stalled: reads blocked for inaction were repeatedly ignored', steps };
      }
      index++;
      continue;
    }
    if (isRead) consecutiveReads++;
    else consecutiveReads = 0;
    if (agentCall.kind === 'done') {
      let summary = agentCall.summary;
      if (filesTouched.size > 0) {
        const root = deps.workspace?.root;
        const list = [...filesTouched.keys()]
          .map((p) => `- \`${root ? `${root}/${p}` : p}\``)
          .join('\n');
        if (list) summary = `${summary}\n\n**Files:**\n${list}`;
      }
      const coverage = `\n\n**Coverage:** ${seenPageStates.size} distinct page states observed over ${steps.length} steps.`;
      summary = `${summary}${coverage}`;
      return { status: 'done', summary, ...(agentCall.data !== undefined ? { data: agentCall.data } : {}), steps };
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
      if (agentCall.skip !== undefined) elementSkip = agentCall.skip;
      record(true, call.name, agentCall.skip !== undefined ? `observation window from element ${elementSkip + 1}` : 'fresh observation taken');
      index++;
      continue;
    }
    if (agentCall.kind === 'note') {
      agentNotes.push(agentCall.text);
      if (deps.workspace && taskDir) {
        try {
          await deps.workspace.plane.append(`${taskDir}/findings.md`, `- ${agentCall.text}\n`);
          filesTouched.set(`${taskDir}/findings.md`, 'note');
        } catch {
        }
      }
      record(true, 'note', agentNoteDetail(agentCall.text));
      index++;
      continue;
    }
    if (agentCall.kind === 'local') {
      if (!deps.workspace) {
        record(false, describeLocal(agentCall.call), 'workspace tools unavailable (backend down or workspace disabled)');
        index++;
        continue;
      }
      const guard = execSpiralGuard(agentCall.call, execCount, fileOps, notes);
      const cmdBlocked = agentCall.call.op === 'exec' && blockedExecCmds.has(agentCall.call.cmd);
      if (guard === 'blocked' || cmdBlocked) {
        record(false, describeLocal(agentCall.call), cmdBlocked ? 'blocked: repeated identical failing command - change the approach' : 'blocked: exec spiral guard - too many commands against the same target');
        index++;
        continue;
      }
      let outcome = await runLocal(agentCall.call, deps.workspace.plane, readLedger, taskDir);
      if (!outcome.ok && agentCall.call.op === 'write_file' && outcome.detail.includes('already exists')) {
        outcome = await runLocal({ op: 'append_file', path: agentCall.call.path, text: `\n${agentCall.call.content}` }, deps.workspace.plane, readLedger, taskDir);
        if (outcome.ok) outcome = { ...outcome, detail: `file existed - content appended instead (${outcome.detail})` };
      }
      if (agentCall.call.op === 'exec') {
        if (outcome.ok) {
          execFailCmd = '';
          execFailStreak = 0;
        } else if (agentCall.call.cmd === execFailCmd) {
          execFailStreak++;
          if (execFailStreak >= 3 && !blockedExecCmds.has(agentCall.call.cmd)) {
            blockedExecCmds.add(agentCall.call.cmd);
            notes.push('That exact command failed 3 times in a row with the same error and is now blocked - it will never succeed as written. Read the error text and CHANGE the approach: create missing directories first, fix the path or url, or pipe into an existing location.');
          }
        } else {
          execFailCmd = agentCall.call.cmd;
          execFailStreak = 1;
        }
      }
      if (outcome.ok && outcome.path) filesTouched.set(outcome.path, agentCall.call.op);
      if (outcome.ok && agentCall.call.op === 'exec' && outcome.text) {
        const digest = outcome.text.replace(/\s+/g, ' ').slice(0, 90);
        execDigests = [...execDigests.slice(-9), `${agentCall.call.cmd.replace(/\s+/g, ' ').slice(0, 50)} -> ${digest}`];
      }
      if (outcome.text !== null && outcome.text !== undefined) {
        latestLocal = { label: outcome.label ?? '', text: outcome.text.length > MAX_LOCAL_CONTEXT ? outcome.text.slice(0, MAX_LOCAL_CONTEXT) + '…' : outcome.text };
      }
      await deps.telemetry?.action(index + 1, {
        tool: agentCall.call.op,
        args: agentCall.call,
        ok: outcome.ok,
        detail: outcome.detail,
        durationMs: outcome.durationMs,
      });
      record(outcome.ok, describeLocal(agentCall.call), outcome.detail);
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

    if (action.type === 'extract' && snapshot?.text) {
      const stateKey = `${snapshot.url}|${snapshot.text.slice(0, 1500)}`;
      const seen = (extractsOnState.get(stateKey) ?? 0) + 1;
      extractsOnState.set(stateKey, seen);
      if (seen > 6) {
        record(false, describeAction(action), 'blocked: this page state has been read 6 times - the answer is not here; navigate, scroll or click instead');
        notes.push('You have extracted from this unchanged page 6 times with different questions. The information you want is not on this page - go to a different page, scroll, or click something to reveal new content.');
        consecutiveBlocked++;
        if (consecutiveBlocked >= STALL_LIMIT) {
          return { status: 'failed', reason: `stalled: extract budget exhausted on an unchanged page`, steps };
        }
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
        return { status: 'failed', reason: `stalled: ${consecutiveBlocked} consecutive chosen actions were all blocked no-ops`, steps };
      }
      continue;
    }
    consecutiveBlocked = 0;
    const seen = (repeatCounts.get(key) ?? 0) + 1;
    repeatCounts.set(key, seen);
    if (seen === LOOP_NUDGE_AT) {
      notes.push('The last actions changed nothing on the page. The element may be a no-op - pick a different element, scroll, or use extract to read more of the page. List items often render as several elements (a checkbox or small buttons inside a container): clicking the checkbox does not open the item - click the CONTAINER whose name is the item\'s title instead.');
    }
    if (seen >= LOOP_BLOCK_AT) {
      blockedKeys.add(key);
      record(false, describeAction(action), `blocked after ${seen} identical attempts with no page change`);
      notes.push('Repeated no-op action is now blocked. This sub-target is a dead end - move on to the next candidate or a different approach instead of retrying.');
      index++;
      continue;
    }

    if (snapshot && (action.type === 'click' || action.type === 'fill' || action.type === 'select' || action.type === 'press')) {
      effectProbe = {
        call: describeAction(action),
        key: `${snapshot.url}|${snapshot.title}|${snapshot.text.length}|${snapshot.text.slice(0, 1500)}`,
      };
    }
    const actionStarted = Date.now();
    const result = await deps.driver.act(action);
    if (action.type === 'new_tab' && result.ok) {
      const tabId = Number((result.data as { tabId?: number } | undefined)?.tabId);
      if (Number.isFinite(tabId)) {
        ownedTabs.set(tabId, new URL(action.url ?? 'about:blank', 'https://x.invalid').hostname || 'blank');
        if (ownedTabs.size > TAB_BUDGET) {
          const oldest = ownedTabs.keys().next().value!;
          ownedTabs.delete(oldest);
          await deps.driver.act({ type: 'close_tab', tabId: oldest }).catch(() => undefined);
          notes.push(`Closed your idle agent tab [${oldest}] to stay within the ${TAB_BUDGET}-tab budget.`);
        }
      }
    }
    if ((action.type === 'switch_tab' || action.type === 'close_tab') && !result.ok) {
      if (ownedTabs.delete(action.tabId)) {
        notes.push(`Tab [${action.tabId}] is gone (closed outside the run) - do not use it again.`);
      }
    }
    if (action.type === 'close_tab' && result.ok) ownedTabs.delete(action.tabId);
    if (result.ok && (action.type === 'goto' || action.type === 'new_tab' || action.type === 'switch_tab')) {
      elementSkip = 0;
    }
    await deps.telemetry?.action(index + 1, {
      tool: action.type,
      args: action,
      ok: result.ok,
      detail: result.detail,
      durationMs: Date.now() - actionStarted,
    });
    if (!result.ok && result.detail.includes('take a new snapshot')) {
      notes.push('That ref no longer exists - the page changed after your last action. Use refs from the LATEST observation only.');
    }
    if (result.ok && action.type === 'extract') {
      const text = result.detail;
      extracts.push({ goal: action.goal, text });
      const digest = text.replace(/\s+/g, ' ').slice(0, 180);
      agentNotes.push(`auto · ${action.goal.slice(0, 50)} → ${digest}`);
      record(true, describeAction(action), `${text.length} chars extracted`);
    } else {
      record(result.ok, describeAction(action), result.detail);
    }
    index++;
  }
  } finally {
    await cleanupOwnedTabs();
  }
}
