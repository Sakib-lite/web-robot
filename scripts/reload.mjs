#!/usr/bin/env node


import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'extension/.output/chrome-mv3');

function log(message) {
  console.log(`[web-robot] ${message}`);
}

function build() {
  log('building…');
  execSync('pnpm build', { cwd: root, stdio: 'inherit' });
  if (!existsSync(resolve(dist, 'manifest.json'))) {
    throw new Error('build produced no manifest.json');
  }
  log('build ok');
}

function chromeDebugTargets() {
  try {
    const json = execSync(
      `curl -s --max-time 2 http://127.0.0.1:9222/json/list`,
      { encoding: 'utf8' },
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function reloadViaDebugger(targets) {
  const extensionPages = targets.filter(
    (t) => t.type === 'background_page' || t.url.startsWith('chrome-extension://'),
  );
  if (extensionPages.length === 0) {
    log('no extension targets visible on :9222 (Chrome hides MV3 workers there)');
    return false;
  }
  for (const target of extensionPages) {
    try {
      execSync(`curl -s --max-time 2 "http://127.0.0.1:9222/json/reload/${target.id}"`, { stdio: 'ignore' });
      log(`reloaded ${target.url}`);
    } catch {
    }
  }
  return true;
}

function manualHint() {
  log('now reload the extension — one click, no chrome://extensions trip:');
  log('  open the web-robot side panel → press the ⟳ button in the top bar');
  log('(the ⟳ button calls chrome.runtime.reload(); the panel closes and reopens fresh)');
}

const targets = chromeDebugTargets();
build();
if (targets && (await reloadViaDebugger(targets))) {
  log('done');
} else {
  try {
    const backend = process.env.WEB_ROBOT_BACKEND ?? 'http://127.0.0.1:3010';
    await fetch(`${backend}/control/reload`, { method: 'POST' });
    log('reload requested through the backend - the extension reboots itself within ~10s');
  } catch {
    log('backend unreachable, cannot auto-reload');
    manualHint();
  }
}
