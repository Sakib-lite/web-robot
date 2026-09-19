import type { ChatMessage, ChatResponse, ToolDef } from '../llm/chatClient';
import type { Action, Driver, Snapshot } from '../driver/types';
import type { LocalPlane } from '../local/plane';
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
  // ties the run to its PLAN.md scratch file (.web-robot/tasks/<taskId>/) so
  // an interrupted task resumes instead of restarting from zero
  taskId?: string;
  // extra system instructions (a selected skill's body)
  preamble?: string;
  // close agent-opened tabs when the run ends (default true)
  cleanupTabs?: boolean;
}

const DEFAULT_MAX_STEPS = 100;
const LOOP_NUDGE_AT = 3;
const LOOP_BLOCK_AT = 5;
const STALL_LIMIT = 6;

const DANGER_PATTERN = /pay|purchase|order|buy|checkout|delete|remove|submit|post|send|confirm/i;

const MAX_LOCAL_CONTEXT = 12000;
const TAB_BUDGET = 6;
const EXEC_TOTAL_SOFT = 40;
const FILE_OPS_NUDGE = 20;
const FILE_OPS_BLOCK = 35;

// guards the exec spiral: one big file sliced across dozens of grep/sed
// turns. counts total execs and per-file mentions (file tools and filenames
// inside shell commands); nudges early, blocks hard.
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

export function parsePlanMd(md: string): { milestones: Array<{ text: string; done: boolean }>; findings: string[] } | null {
  const milestones: Array<{ text: string; done: boolean }> = [];
  const findings: string[] = [];
  let section = '';
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    const milestone = /^- \[([ x])\] (.*)$/.exec(line.trim());
    if (section === 'milestones' && milestone) {
      milestones.push({ text: milestone[2]!, done: milestone[1] === 'x' });
      continue;
    }
    const finding = /^- (.+)$/.exec(line.trim());
    if (section === 'findings' && finding && !milestone) findings.push(finding[1]!);
  }
  if (milestones.length === 0 && findings.length === 0) return null;
  return { milestones, findings };
}

interface LocalOutcome {
  ok: boolean;
  detail: string;
  label?: string;
  text?: string | null;
  durationMs: number;
}

async function runLocal(call: LocalCall, plane: LocalPlane, ledger: Set<string>): Promise<LocalOutcome> {
  const started = Date.now();
  const dur = () => Date.now() - started;
  const norm = (p: string) => p.replace(/^\.\//, '');
  try {
    switch (call.op) {
      case 'list_dir': {
        const { entries, truncated } = await plane.list(call.path);
        const text = entries
          .map((e) => `${e.name}${e.dir ? '/' : ''}${e.dir ? '' : ` · ${e.size ?? '?'} B`}${e.mtime ? ` · ${e.mtime}` : ''}`)
          .join('\n');
        return { ok: true, detail: `${entries.length} entries${truncated ? ' (truncated at 200)' : ''}`, label: `list ${call.path ?? '.'}`, text: text || '(empty directory)', durationMs: dur() };
      }
      case 'read_file': {
        const slice = await plane.read(call.path, call.offset, call.limit);
        ledger.add(norm(call.path));
        const end = slice.offset + slice.lines.length - 1;
        const text = slice.lines.map((l) => `${l.n}\t${l.text}`).join('\n');
        return {
          ok: true,
          detail: `lines ${slice.offset}-${end} of ${slice.totalLines}`,
          label: `${call.path} (lines ${slice.offset}-${end} of ${slice.totalLines})`,
          text: text || '(empty file)',
          durationMs: dur(),
        };
      }
      case 'write_file': {
        if (!ledger.has(norm(call.path))) {
          // unexplored path: try create-only; an EXISTS reply means the model
          // is blind-overwriting a file it never read
          try {
            const res = await plane.write(call.path, call.content, true);
            return { ok: true, detail: `created ${call.path} (${res.bytes} bytes)`, text: null, durationMs: dur() };
          } catch (error) {
            if (error instanceof PlaneError && error.code === 'EXISTS') {
              return { ok: false, detail: error.message, text: null, durationMs: dur() };
            }
            throw error;
          }
        }
        const res = await plane.write(call.path, call.content);
        return { ok: true, detail: `wrote ${res.bytes} bytes to ${call.path}`, text: null, durationMs: dur() };
      }
      case 'edit_file': {
        if (!ledger.has(norm(call.path))) {
          return { ok: false, detail: `blocked: read_file ${call.path} first - blind edits are not allowed`, text: null, durationMs: dur() };
        }
        const res = await plane.edit(call.path, call.oldString, call.newString, call.replaceAll);
        return { ok: true, detail: `replaced ${res.occurrences} occurrence(s) at line ${res.line}`, text: null, durationMs: dur() };
      }
      case 'append_file': {
        const res = await plane.append(call.path, call.text);
        return { ok: true, detail: `appended ${res.bytes} bytes (file now ${res.totalBytes} bytes)`, text: null, durationMs: dur() };
      }
      case 'delete_path': {
        await plane.delete(call.path);
        return { ok: true, detail: `deleted ${call.path}`, text: null, durationMs: dur() };
      }
      case 'mkdir': {
        await plane.mkdir(call.path);
        return { ok: true, detail: `created ${call.path}`, text: null, durationMs: dur() };
      }
      case 'exec': {
        const res = await plane.exec(call.cmd, call.timeoutMs);
        const summary = `exit ${res.code} (${(res.durationMs / 1000).toFixed(1)}s)${res.timedOut ? ' - TIMED OUT' : ''}`;
        const text = res.output.trim();
        return { ok: res.code === 0, detail: summary, label: `exec ${call.cmd.slice(0, 80)}`, text: text ? `${summary}\n${text}` : null, durationMs: dur() };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.slice(0, 300), text: null, durationMs: dur() };
  }
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
  let maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: StepRecord[] = [];
  const stepLines: string[] = [];
  const userAnswers: string[] = [];
  const extracts: Array<{ goal: string; text: string }> = [];
  const agentNotes: string[] = [];
  const repeatCounts = new Map<string, number>();
  const blockedKeys = new Set<string>();
  // files read this task - edit_file and overwrites are refused until the
  // model has actually seen the content (ZCode's read-before-edit rule)
  const readLedger = new Set<string>();
  // only the latest read/list/exec output stays in context, bounded - older
  // ones live on in the step log as one-liners
  let latestLocal: { label: string; text: string } | null = null;
  // spiral guards for local tools: the classic failure is 100+ grep/sed
  // slices of one big file, each a full agent turn that forgot the last
  const execCount = { total: 0 };
  const fileOps = new Map<string, number>();
  // rolling memory of recent exec results so the model never re-runs a
  // command whose output it already saw (exec amnesia)
  let execDigests: string[] = [];
  // milestone plan + its PLAN.md mirror: written by loop code, not model turns
  let plan: Array<{ text: string; done: boolean }> | null = null;
  const planFindings: string[] = [];
  let planFileInit = false;
  const planPath = deps.taskId ? `.web-robot/tasks/${deps.taskId}/PLAN.md` : null;
  // tabs this run opened - marked in observations, budget-capped, closed at end
  const ownedTabs = new Map<number, string>();
  let reinvestigations = 0;
  let consecutiveBlocked = 0;
  let notes: string[] = [];
  let noToolStrikes = 0;
  let index = 0;

  async function persistPlan() {
    if (!deps.workspace || !planPath) return;
    const md = [
      `# ${task.slice(0, 120)}`,
      '',
      '## Milestones',
      ...(plan ?? []).map((p) => `${p.done ? '- [x]' : '- [ ]'} ${p.text}`),
      '',
      '## Findings',
      ...planFindings.map((f) => `- ${f}`),
      '',
    ].join('\n');
    try {
      await deps.workspace.plane.write(planPath, md);
      planFileInit = true;
    } catch {
      // the plan also lives in context; a failed write must not kill the run
    }
  }

  async function persistFinding(text: string) {
    if (!deps.workspace || !planPath) return;
    if (!planFileInit) {
      await persistPlan();
      planFindings.push(text);
      await persistPlan();
      return;
    }
    planFindings.push(text);
    try {
      await deps.workspace.plane.append(planPath, `- ${text}\n`);
    } catch {
      // same tolerance as above
    }
  }

  // resume-on-reclaim: a re-queued task that already has a PLAN.md restarts
  // with its milestones and findings instead of from zero
  if (deps.workspace && planPath) {
    try {
      const slice = await deps.workspace.plane.read(planPath, 1, 400);
      const parsed = parsePlanMd(slice.lines.map((l) => l.text).join('\n'));
      if (parsed) {
        plan = parsed.milestones;
        planFindings.push(...parsed.findings);
        planFileInit = true;
        agentNotes.push(...parsed.findings);
        notes.push(
          'This run was interrupted and has RESUMED. The milestone plan and findings above are your earlier verified progress: continue from the first unchecked milestone and do NOT redo completed work.',
        );
      }
    } catch {
      // no plan yet - first run
    }
  }

  function record(ok: boolean, call: string, detail: string) {
    const step: StepRecord = { index: index + 1, call, detail, ok };
    steps.push(step);
    stepLines.push(ok ? `${step.call} → ${detail}` : `${step.call} → failed: ${detail}`);
    deps.onStep?.(step);
  }

  // failure re-investigation: before accepting any failure, one verdict call
  // decides resume (with a concrete next instruction + fresh step budget) or
  // confirmed failure - partial progress beats giving up
  async function reinvestigate(reason: string): Promise<{ resume: string } | { giveUp: true }> {
    if (reinvestigations >= 2) return { giveUp: true };
    reinvestigations++;
    const context = [
      `TASK:\n${task}`,
      plan && plan.length > 0 ? `PLAN:\n${plan.map((p) => `${p.done ? '[x]' : '[ ]'} ${p.text}`).join('\n')}` : '',
      `STEPS SO FAR (last 15):\n${stepLines.slice(-15).join('\n')}`,
      `FAILURE:\n${reason}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const verdictTools: ToolDef[] = [
      {
        name: 'resume',
        description: 'Continue the task from where it failed with a concrete next instruction.',
        parameters: { type: 'object', properties: { next_instruction: { type: 'string' } }, required: ['next_instruction'] },
      },
      {
        name: 'confirm_fail',
        description: 'The task is genuinely impossible; finalize it as failed.',
        parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      },
    ];
    try {
      const res = await deps.chat(
        [
          {
            role: 'system',
            content:
              'A web-robot run just failed. Decide: resume it with a concrete next instruction, or confirm the failure. Prefer resume whenever any progress or any remaining path exists - partial results beat giving up. ',
          },
          { role: 'user', content: context },
        ],
        verdictTools,
      );
      const call = res.toolCalls[0];
      if (call?.name === 'resume' && typeof call.args.next_instruction === 'string' && call.args.next_instruction.trim()) {
        return { resume: call.args.next_instruction.trim().slice(0, 400) };
      }
      return { giveUp: true };
    } catch {
      return { giveUp: true };
    }
  }

  async function cleanupOwnedTabs() {
    if (deps.cleanupTabs === false || ownedTabs.size === 0) return;
    for (const tabId of [...ownedTabs.keys()]) {
      try {
        await deps.driver.act({ type: 'close_tab', tabId });
      } catch {
        // already closed by the user - nothing to do
      }
    }
    ownedTabs.clear();
  }

  try {
  while (true) {
    if (deps.signal?.aborted) return { status: 'stopped', reason: 'cancelled by user', steps };
    if (index >= maxSteps) {
      const verdict = await reinvestigate(`step limit of ${maxSteps} reached`);
      if ('resume' in verdict) {
        maxSteps += 25;
        notes.push(`The step limit hit, but re-investigation granted a fresh budget of 25 more steps. RESUME INSTRUCTION: ${verdict.resume}`);
        continue;
      }
      return { status: 'failed', reason: `step limit of ${maxSteps} reached (confirmed by re-investigation)`, steps };
    }

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
      { role: 'system', content: systemPrompt(deps.workspace?.root) },
      ...(deps.preamble ? [{ role: 'system' as const, content: deps.preamble }] : []),
      { role: 'user', content: taskContext(task, stepLines, userAnswers, extracts, agentNotes, latestLocal, plan, execDigests) },
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
    if (index + 1 === 20 && agentNotes.length === 0) {
      messages.push({
        role: 'system',
        content: 'You have recorded no findings so far. Call note(text) after every verified fact (target: result + source url) - your notes are how you avoid re-doing work.',
      });
    }

    let res: ChatResponse;
    const chatStarted = Date.now();
    try {
      res = await deps.chat(messages, toolDefs({ workspace: !!deps.workspace }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await deps.telemetry?.llm(index + 1, { messages, error: reason, durationMs: Date.now() - chatStarted });
      const verdict = await reinvestigate(`llm error: ${reason}`);
      if ('resume' in verdict) {
        maxSteps += 25;
        notes.push(`The model call failed once, but re-investigation decided to continue. RESUME INSTRUCTION: ${verdict.resume}`);
        continue;
      }
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
      noToolStrikes++;
      if (noToolStrikes >= 3) {
        const reason = `model stopped calling tools${empty ? ' (empty replies)' : ''}: ${res.content.slice(0, 200)}`;
        const verdict = await reinvestigate(reason);
        if ('resume' in verdict) {
          noToolStrikes = 0;
          maxSteps += 25;
          notes.push(`The model went silent, but re-investigation decided to continue. RESUME INSTRUCTION: ${verdict.resume}`);
          continue;
        }
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
    if (agentCall.kind === 'done') {
      return { status: 'done', summary: agentCall.summary, ...(agentCall.data !== undefined ? { data: agentCall.data } : {}), steps };
    }
    if (agentCall.kind === 'fail') {
      const verdict = await reinvestigate(`the model gave up: ${agentCall.reason}`);
      if ('resume' in verdict) {
        maxSteps += 25;
        notes.push(`A give-up verdict was overruled by re-investigation - partial progress exists. RESUME INSTRUCTION: ${verdict.resume}`);
        continue;
      }
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
      await persistFinding(agentCall.text);
      record(true, 'note', agentNoteDetail(agentCall.text));
      index++;
      continue;
    }
    if (agentCall.kind === 'plan') {
      plan = agentCall.items.map((item) => ({ text: item.text, done: item.done === true }));
      await persistPlan();
      const done = plan.filter((p) => p.done).length;
      record(true, 'update_plan', `${done}/${plan.length} milestones done`);
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
      if (guard === 'blocked') {
        record(false, describeLocal(agentCall.call), 'blocked: exec spiral guard - too many commands against the same target');
        index++;
        continue;
      }
      const outcome = await runLocal(agentCall.call, deps.workspace.plane, readLedger);
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

    const key = actionKey(action, snapshot);
    if (blockedKeys.has(key)) {
      consecutiveBlocked++;
      record(false, describeAction(action), 'blocked: same action already repeated with no page change');
      notes.push('That exact action is blocked on this unchanged page (it did nothing last time). Pick a different element, scroll, extract, or continue with the rest of the task elsewhere.');
      index++;
      if (consecutiveBlocked >= STALL_LIMIT) {
        const verdict = await reinvestigate(`stalled: ${consecutiveBlocked} consecutive chosen actions were blocked no-ops`);
        if ('resume' in verdict) {
          consecutiveBlocked = 0;
          maxSteps += 25;
          notes.push(`The run stalled on no-op actions, but re-investigation found a path forward. RESUME INSTRUCTION: ${verdict.resume}`);
          continue;
        }
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
