#!/usr/bin/env node

// rebuilds the extension and reloads every unpacked web-robot target in the
// running Chrome via the DevTools HTTP endpoint of an already-open debugging
// port; falls back to plain rebuild + manual reload hint when the port is off

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
      // target may have gone away mid-loop
    }
  }
  return true;
}

// chrome.reload() through the extension's own service worker is the reliable
// path; reach it via the remote-debugging pipe only when the user started
// chrome with a debug port. otherwise print the two-click instruction.
function manualHint() {
  log('could not reach Chrome on :9222 — do the 2-click reload:');
  log('  chrome://extensions → web-robot → ↻');
  log('(one-time fix: run Chrome once with  --remote-debugging-port=9222 --user-data-dir=$HOME/.web-robot-chrome)');
}

const targets = chromeDebugTargets();
build();
if (targets && (await reloadViaDebugger(targets))) {
  log('done');
} else {
  manualHint();
}
