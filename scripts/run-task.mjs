#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const BACKEND = process.env.WEB_ROBOT_BACKEND ?? 'http://127.0.0.1:3010';

async function post(path, body) {
  const res = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BACKEND}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

const flagsWithValues = new Set(['--repeat', '--file', '--model', '--effort', '--skill', '--context', '--continue', '--step']);

async function runOne(taskText, label, overrides = {}) {
  const { taskId } = await post('/queue', { taskText, ...overrides });
  return waitAndReport(taskId, label);
}

async function waitAndReport(taskId, label) {
  const started = Date.now();
  let status = 'queued';
  let fetchFailures = 0;
  while (status === 'queued' || status === 'starting' || status === 'running') {
    try {
      ({ status } = await get(`/tasks/wait?id=${taskId}&timeoutMs=600000`));
      fetchFailures = 0;
    } catch (error) {
      // a single tcp blip on the long-poll must not kill the whole batch -
      // the task keeps running server-side regardless
      fetchFailures++;
      if (fetchFailures > 5) throw error;
      console.error(`[web-robot] wait blip (${error instanceof Error ? error.message : String(error)}) - retrying`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  const report = await get(`/tasks/${taskId}/debug`);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n=== [${label}] ${report.task.status.toUpperCase()} (${seconds}s, ${report.task.stepCount} steps) ===`);
  if (report.task.summary) console.log(`summary: ${report.task.summary.slice(0, 300)}`);
  if (report.task.reason) console.log(`reason: ${report.task.reason}`);
  for (const failure of report.failures.slice(0, 6)) {
    console.log(`  step ${failure.step} [${failure.kind}] ${failure.what.slice(0, 130)}`);
  }
  console.log(`trace: ${BACKEND}/tasks/${taskId}/debug`);
  return report;
}

async function main() {
  if (process.argv.includes('--reload')) {
    await post('/control/reload');
    console.log('[web-robot] reload requested - extension reboots itself on next poll');
    return;
  }
  if (process.argv.includes('--worker')) {
    const on = !process.argv.includes('off');
    await post('/worker/control', { enabled: on });
    console.log(`[web-robot] worker ${on ? 'enabled' : 'disabled'} - the extension applies it on its next poll and the settings toggle follows`);
    return;
  }
  if (process.argv.includes('--ws')) {
    const on = !process.argv.includes('off');
    const res = await post('/workspace/control', { enabled: on });
    console.log(`[web-robot] workspace tools ${res.enabled ? 'enabled' : 'disabled'} - file/exec tools are ${res.enabled ? 'live again' : 'refused by the backend'}`);
    return;
  }

  const args = process.argv.slice(2);
  const continueIndex = args.indexOf('--continue');
  if (continueIndex >= 0) {
    const id = Number(args[continueIndex + 1]);
    const positional = args.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && flagsWithValues.has(args[i - 1])));
    const message = positional[0];
    if (!id || !message) {
      console.error('usage: node scripts/run-task.mjs --continue <taskId> "message"');
      process.exit(1);
    }
    await post(`/tasks/${id}/continue`, { message });
    console.log(`[web-robot] continuation queued for task ${id} - waiting for it to finish`);
    await waitAndReport(id, `continue #${id}`);
    return;
  }

  const worker = await get('/worker/status');
  const alive = Object.entries(worker.sources ?? {}).filter(([, s]) => s.state !== 'off' && s.ageMs < 120000);
  if (alive.length === 0) {
    console.error('[web-robot] no live worker: chrome closed or the remote-worker toggle is off in settings - task would just sit queued');
    console.error('           start chrome with the web-robot extension, or run: node scripts/run-task.mjs --worker on');
    process.exit(1);
  }
  console.log(`[web-robot] worker alive: ${alive.map(([src, s]) => `${src} (${s.state})`).join(', ')}`);

  const repeatIndex = args.indexOf('--repeat');
  const repeat = repeatIndex >= 0 ? Math.max(1, Number(args[repeatIndex + 1] ?? 1)) : 1;
  const fileIndex = args.indexOf('--file');

  const flagValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const overrides = {};
  for (const flag of ['model', 'effort', 'skill', 'context']) {
    const value = flagValue(`--${flag}`);
    if (value) overrides[flag] = value;
  }
  const stepValues = args.filter((arg, i) => i > 0 && args[i - 1] === '--step' && arg && !arg.startsWith('--'));
  if (stepValues.length) overrides.steps = stepValues;
  let taskTexts;
  if (fileIndex >= 0) {
    taskTexts = readFileSync(args[fileIndex + 1], 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    const positional = args.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && flagsWithValues.has(args[i - 1])));
    const taskText = positional[0];
    if (!taskText) {
      console.error('usage: node scripts/run-task.mjs "task" | --repeat N "task" | --file tasks.txt | --model glm-5.3 --effort low --skill <slug> | --context <slug> | --step "..." (repeatable) | --continue <taskId> "message" | --reload | --worker on|off | --ws on|off');
      process.exit(1);
    }
    taskTexts = Array.from({ length: repeat }, () => taskText);
  }

  console.log(`[web-robot] ${taskTexts.length} task(s) queued sequentially - extension runs them one by one, stop anytime with Ctrl+C (queued ones can be drained later)`);
  for (let i = 0; i < taskTexts.length; i++) {
    await runOne(taskTexts[i], `${i + 1}/${taskTexts.length}`, overrides);
  }
}

main().catch((error) => {
  console.error(`[web-robot] ${error.message}`);
  console.error('is the backend running? (pnpm backend)');
  process.exit(1);
});
