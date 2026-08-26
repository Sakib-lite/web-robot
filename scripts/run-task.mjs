#!/usr/bin/env node

// queues a task for the extension, waits for it to finish, then prints the
// failures and the debug url:
//   node scripts/run-task.mjs "open example.com and tell me the heading"
//   node scripts/run-task.mjs --reload          # ask the extension to reload itself

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

async function main() {
  if (process.argv.includes('--reload')) {
    await post('/control/reload');
    console.log('[web-robot] reload requested - extension reboots itself on next poll');
    return;
  }

  const taskText = process.argv[2];
  if (!taskText) {
    console.error('usage: node scripts/run-task.mjs "task text" | --reload');
    process.exit(1);
  }

  const { taskId } = await post('/queue', { taskText });
  console.log(`[web-robot] queued task ${taskId}`);
  console.log('[web-robot] waiting for the extension to pick it up and finish…');

  const started = Date.now();
  for (;;) {
    const { status } = await get(`/tasks/wait?id=${taskId}&timeoutMs=600000`);
    if (status !== 'timeout') {
      console.log(`[web-robot] finished after ${Math.round((Date.now() - started) / 1000)}s: ${status}`);
      break;
    }
    console.log('[web-robot] still running… (10 min timeout hit, continuing to wait)');
  }

  const report = await get(`/tasks/${taskId}/debug`);
  console.log(`\n=== ${report.task.status.toUpperCase()} ===`);
  if (report.task.summary) console.log(`summary: ${report.task.summary}`);
  if (report.task.reason) console.log(`reason: ${report.task.reason}`);
  if (report.failures.length > 0) {
    console.log('\nfailures:');
    for (const failure of report.failures) console.log(`  step ${failure.step} [${failure.kind}] ${failure.what.slice(0, 140)}`);
  }
  console.log(`\nfull trace: ${BACKEND}/tasks/${taskId}/debug`);
}

main().catch((error) => {
  console.error(`[web-robot] ${error.message}`);
  console.error('is the backend running? (pnpm backend)');
  process.exit(1);
});
