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

const DEFAULT_MAX_STEPS = 150;
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
  const seenPageStates = new Set<string>();
  const repeatCounts = new Map<string, number>();
  const blockedKeys = new Set<string>();
  const readLedger = new Set<string>();
  let latestLocal: { label: string; text: string } | null = null;
  const execCount = { total: 0 };
  const fileOps = new Map<string, number>();
  let execDigests: string[] = [];
  let plan: Array<{ text: string; done: boolean }> | null = null;
  const planFindings: string[] = [];
  let planFileInit = false;
  const taskDir = deps.taskId != null ? `.web-robot/tasks/${deps.taskId}` : null;
  const filesTouched = new Map<string, string>();
  const planPath = taskDir ? `${taskDir}/PLAN.md` : null;
  const ownedTabs = new Map<number, string>();
  let reinvestigations = 0;
  let consecutiveBlocked = 0;
  let stallGrace: number | null = null;
  let elementSkip = 0;
  let defeatBounces = 0;
  let planLoopStrikes = 0;
  let planLoopGrace = false;
  let execFailCmd = '';
  let execFailStreak = 0;
  const blockedExecCmds = new Set<string>();
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
    }
  }

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
    }
  }
  if (deps.steps && deps.steps.length > 0 && !plan) {
    plan = deps.steps.map((text, i) => ({ text: `STEP ${i + 1}: ${text}`, done: false }));
    await persistPlan();
  }

  function record(ok: boolean, call: string, detail: string) {
    const step: StepRecord = { index: index + 1, call, detail, ok };
    steps.push(step);
    stepLines.push(ok ? `${step.call} → ${detail}` : `${step.call} → failed: ${detail}`);
    deps.onStep?.(step);
  }

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
      snapshot = await deps.driver.snapshot(elementSkip);
      if (snapshot?.text) seenPageStates.add(snapshot.text.slice(0, 500));
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
            content: `USER STEPS for this task (execute IN ORDER - they are your milestone plan; check each off with update_plan as you finish it. HOW you accomplish each step is your decision - the steps define WHAT must exist at the end):\n${deps.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
          }]
        : []),
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
      const defeatist = /incomplete|unable|couldn't|could not|cannot be completed|can't be completed|gave up|not fully|hardly|barely|no (?:data|results|details|findings) (?:were )?(?:collected|extracted|found)|did not succeed|without success|no effect/i.test(agentCall.summary);
      if (defeatist && filesTouched.size === 0 && defeatBounces < 2) {
        defeatBounces++;
        record(false, 'done', 'bounced: claims incompleteness without having produced anything');
        notes.push(
          defeatBounces === 1
            ? 'Your done call claims the task is incomplete but you have produced nothing (no files, no notes-backed findings). Do the work instead: page through the element list with snapshot(skip=...), click/extract item by item, and append each verified batch to your deliverable file. Only call done when finished, or fail with the real blocker.'
            : 'Second defeatist done. You must NOT call done while the task is incomplete and nothing was produced. Either continue working (extract per row, append_file batches) or call fail with the exact blocker that stops you. A bare "could not interact" claim is not a blocker - name the specific page element or error.',
        );
        index++;
        continue;
      }
      let summary = agentCall.summary;
      if (filesTouched.size > 0) {
        const root = deps.workspace?.root;
        const list = [...filesTouched.keys()]
          .filter((p) => p !== planPath)
          .map((p) => `- \`${root ? `${root}/${p}` : p}\``)
          .join('\n');
        if (list) summary = `${summary}\n\n**Files:**\n${list}`;
      }
      const coverage = `\n\n**Coverage:** ${seenPageStates.size} distinct page states observed over ${steps.length} steps.`;
      summary = `${summary}${coverage}`;
      return { status: 'done', summary, ...(agentCall.data !== undefined ? { data: agentCall.data } : {}), steps };
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
      if (agentCall.skip !== undefined) elementSkip = agentCall.skip;
      record(true, call.name, agentCall.skip !== undefined ? `observation window from element ${elementSkip + 1}` : 'fresh observation taken');
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
    if (agentCall.kind !== 'plan') planLoopStrikes = 0;
    if (agentCall.kind === 'plan') {
      const next = agentCall.items.map((item) => ({ text: item.text, done: item.done === true }));
      const changed = plan === null || JSON.stringify(next) !== JSON.stringify(plan);
      planLoopStrikes++;
      plan = next;
      await persistPlan();
      const done = plan.filter((p) => p.done).length;
      record(changed, 'update_plan', changed ? `${done}/${plan.length} milestones done` : 'plan unchanged - no progress');
      if (planLoopStrikes === 3) {
        notes.push('You keep rewriting the plan instead of working. The plan is good enough - EXECUTE it now: take the next unchecked milestone with real actions (goto, click, extract, note, file tools). Do not call update_plan again until a milestone actually completes.');
      }
      if (planLoopStrikes >= 6) {
        if (!planLoopGrace) {
          planLoopGrace = true;
          planLoopStrikes = 0;
          maxSteps += 10;
          notes.push('FINAL WARNING: you have rewritten the plan many times and done NOTHING else. update_plan is now ignored. Your very next call must be a real action for the first unchecked milestone (goto the site, snapshot, extract, click, write_file) - anything else fails the task.');
          continue;
        }
        return { status: 'failed', reason: `stalled: ${planLoopStrikes} consecutive update_plan calls with no real action in between`, steps };
      }
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
      const outcome = await runLocal(agentCall.call, deps.workspace.plane, readLedger, taskDir);
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

    const key = actionKey(action, snapshot);
    if (blockedKeys.has(key)) {
      consecutiveBlocked++;
      record(false, describeAction(action), 'blocked: same action already repeated with no page change');
      notes.push('That exact action is blocked on this unchanged page (it did nothing last time). Pick a different element, scroll, extract, or continue with the rest of the task elsewhere.');
      index++;
      if (consecutiveBlocked >= STALL_LIMIT) {
        if (stallGrace !== null) {
          return { status: 'failed', reason: `stalled: still picking no-op actions after the partial-results instruction (grace steps used)`, steps };
        }
        const verdict = await reinvestigate(`stalled: ${consecutiveBlocked} consecutive chosen actions were blocked no-ops`);
        if ('resume' in verdict) {
          consecutiveBlocked = 0;
          maxSteps += 25;
          notes.push(`The run stalled on no-op actions, but re-investigation found a path forward. RESUME INSTRUCTION: ${verdict.resume}`);
          continue;
        }
        stallGrace = 5;
        consecutiveBlocked = 0;
        notes.push('You are repeating actions that change nothing. STOP retrying. Call done NOW with a partial summary: what you found, which files you wrote (with paths), and what stayed blocked and why. A partial result beats failing - do not attempt more page actions on this target.');
        continue;
      }
      if (stallGrace !== null) {
        stallGrace -= 1;
        if (stallGrace <= 0) {
          return { status: 'failed', reason: 'stalled: partial-results grace steps exhausted without calling done', steps };
        }
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
