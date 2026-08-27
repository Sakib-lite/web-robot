#!/usr/bin/env node

// queues tasks for the extension, waits for each to finish, prints failures + debug url:
//   node scripts/run-task.mjs "open example.com and tell me the heading"
//   node scripts/run-task.mjs --repeat 10 "list my github repos"     # same task 10x, sequentially
//   node scripts/run-task.mjs --file tasks.txt                       # one task per line, sequentially
//   node scripts/run-task.mjs --reload                               # ask the extension to reload itself

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

async function runOne(taskText, label) {
  const { taskId } = await post('/queue', { taskText });
  const started = Date.now();
  let status = 'queued';
  while (status === 'queued' || status === 'running') {
    ({ status } = await get(`/tasks/wait?id=${taskId}&timeoutMs=600000`));
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

  const repeatIndex = process.argv.indexOf('--repeat');
  const repeat = repeatIndex >= 0 ? Math.max(1, Number(process.argv[repeatIndex + 1] ?? 1)) : 1;
  const fileIndex = process.argv.indexOf('--file');

  let taskTexts;
  if (fileIndex >= 0) {
    taskTexts = readFileSync(process.argv[fileIndex + 1], 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    const taskText = process.argv.filter((arg, i) => !['--repeat', '--file'].includes(arg) && ![process.argv[repeatIndex + 1], process.argv[fileIndex + 1]].includes(arg))[2];
    if (!taskText) {
      console.error('usage: node scripts/run-task.mjs "task" | --repeat N "task" | --file tasks.txt | --reload');
      process.exit(1);
    }
    taskTexts = Array.from({ length: repeat }, () => taskText);
  }

  console.log(`[web-robot] ${taskTexts.length} task(s) queued sequentially - extension runs them one by one, stop anytime with Ctrl+C (queued ones can be drained later)`);
  for (let i = 0; i < taskTexts.length; i++) {
    await runOne(taskTexts[i], `${i + 1}/${taskTexts.length}`);
  }
}

main().catch((error) => {
  console.error(`[web-robot] ${error.message}`);
  console.error('is the backend running? (pnpm backend)');
  process.exit(1);
});
