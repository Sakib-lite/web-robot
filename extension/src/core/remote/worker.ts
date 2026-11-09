import type { ClaimedTask } from '../common/types';
import { handleMessage } from '../background/router';
import { createDriver, createExtensionDriver } from '../driver/extensionDriver';
import { createHttpPlane } from '../local/httpPlane';
import { resolveActiveProvider, createProductStore } from '../llm/providers';
import { getProduct } from '../llm/products';
import { chromeArea } from '../storage/area';
import { runClaimedTask } from './claim';
import { runRemoteTask } from '../telemetry/client';
import { getBackendUrl, isRemoteWorkerEnabled, saveRemoteWorkerEnabled } from '../telemetry/settings';

export interface RemoteDeps {
  source: string;
  fetchFn: typeof fetch;
  reload: () => void;
  runTask: (claim: ClaimedTask, backendUrl: string) => Promise<void>;
  getBackend: () => Promise<string>;
  getWorkerEnabled: () => Promise<boolean>;
  saveWorkerEnabled: (enabled: boolean) => Promise<void>;
  showPanel: () => Promise<void>;
}

let busy = false;
let currentTaskId: number | null = null;

export async function maybeRunRemoteWork(deps: RemoteDeps): Promise<string> {
  let backendUrl: string;
  try {
    backendUrl = await deps.getBackend();
  } catch {
    return 'idle (no backend url)';
  }
  if (busy) {
    if (currentTaskId) {
      await deps
        .fetchFn(`${backendUrl}/worker/status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: deps.source, state: 'busy', currentTask: currentTaskId }),
          signal: AbortSignal.timeout(4000),
        })
        .catch(() => undefined);
      try {
        const res = await deps.fetchFn(`${backendUrl}/tasks?limit=30`, { signal: AbortSignal.timeout(4000) });
        const rows = (await res.json()) as Array<{ id: number; status: string }>;
        const mine = Array.isArray(rows) ? rows.find((t) => t.id === currentTaskId) : undefined;
        if (mine && ['stopped', 'failed', 'completed', 'done', 'canceled'].includes(mine.status)) {
          deps.reload();
          return `zombie runner for task ${currentTaskId} (${mine.status}) - rebooting`;
        }
      } catch {
      }
    }
    return 'busy';
  }
  busy = true;
  try {

    let control: { reload?: boolean; workerEnabled?: boolean };
    try {
      const res = await deps.fetchFn(`${backendUrl}/control/reload?src=${deps.source}`, { signal: AbortSignal.timeout(4000) });
      control = (await res.json()) as { reload?: boolean; workerEnabled?: boolean };
    } catch (error) {
      return `idle (control fetch failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    if (control?.reload) {
      deps.reload();
      return 'reloading';
    }

    const heartbeat = (state: string) =>
      deps.fetchFn(`${backendUrl}/worker/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: deps.source, state }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => undefined);

    const localEnabled = await deps.getWorkerEnabled();
    if (typeof control?.workerEnabled === 'boolean' && control.workerEnabled !== localEnabled) {
      await deps.saveWorkerEnabled(control.workerEnabled);
    }
    if (!(await deps.getWorkerEnabled())) {
      await heartbeat('off');
      return 'off (disabled in settings)';
    }
    await heartbeat('idle');

    let queued: { taskId?: number; taskText?: string; skill?: string; model?: string; effort?: string; context?: string };
    try {
      const res = await deps.fetchFn(`${backendUrl}/queue/next?src=${deps.source}`, { signal: AbortSignal.timeout(4000) });
      queued = (await res.json()) as { taskId?: number; taskText?: string };
    } catch (error) {
      return `idle (queue fetch failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    if (queued?.taskId && queued.taskText) {
      currentTaskId = queued.taskId;
      try {
        await deps.showPanel().catch(() => undefined);
        await deps.runTask(queued as ClaimedTask, backendUrl);
      } finally {
        currentTaskId = null;
      }
      return 'started';
    }
    return `idle (queue empty)`;
  } finally {
    busy = false;
  }
}

export function defaultRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(
    () => createDriver((message) => handleMessage(message, { tabs: chrome.tabs, scripting: chrome.scripting, debugger: chrome.debugger })),
    'sw',
  );
}

export function panelRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(() => createExtensionDriver(), 'panel');
}

function remoteDepsForDriver(makeDriver: () => ReturnType<typeof createDriver>, source: string): RemoteDeps {
  return {
    source,
    fetchFn: (url, init) => fetch(url, init),
    reload: () => chrome.runtime.reload(),
    getBackend: () => getBackendUrl(chromeArea()),
    getWorkerEnabled: () => isRemoteWorkerEnabled(chromeArea()),
    saveWorkerEnabled: (enabled) => saveRemoteWorkerEnabled(enabled, chromeArea()),
    showPanel: openExtensionPanel,
    runTask: async (claim, backendUrl) => {
      await runClaimedTask(claim, backendUrl, makeDriver);
    },
  };
}

export async function openExtensionPanel(): Promise<void> {
  try {
    const window = await chrome.windows.getLastFocused();
    if (window.id === undefined) throw new Error('no focused window');
    await chrome.sidePanel.open({ windowId: window.id });
    return;
  } catch {
  }
  const url = chrome.runtime.getURL('sidepanel.html');
  const existing = await chrome.tabs.query({ url });
  const tab = existing[0];
  if (tab && tab.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
