import { handleMessage } from '../background/router';
import { createDriver, createExtensionDriver } from '../driver/extensionDriver';
import { resolveActiveProvider, createProductStore } from '../llm/providers';
import { chromeArea } from '../storage/area';
import { runRemoteTask } from '../telemetry/client';
import { getBackendUrl, isRemoteWorkerEnabled, saveRemoteWorkerEnabled } from '../telemetry/settings';

export interface RemoteDeps {
  source: string;
  fetchFn: typeof fetch;
  reload: () => void;
  runTask: (taskId: string, taskText: string, backendUrl: string) => Promise<void>;
  getBackend: () => Promise<string>;
  getWorkerEnabled: () => Promise<boolean>;
  saveWorkerEnabled: (enabled: boolean) => Promise<void>;
  showPanel: () => Promise<void>;
}

let busy = false;

export async function maybeRunRemoteWork(deps: RemoteDeps): Promise<string> {
  if (busy) return 'busy';
  busy = true;
  try {
    const backendUrl = await deps.getBackend();

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

    // a pending control from the backend wins: apply it to storage so the
    // settings toggle reflects it on the next read
    const localEnabled = await deps.getWorkerEnabled();
    if (typeof control?.workerEnabled === 'boolean' && control.workerEnabled !== localEnabled) {
      await deps.saveWorkerEnabled(control.workerEnabled);
    }
    if (!(await deps.getWorkerEnabled())) {
      await heartbeat('off');
      return 'off (disabled in settings)';
    }
    await heartbeat('idle');

    let queued: { taskId?: string; taskText?: string };
    try {
      const res = await deps.fetchFn(`${backendUrl}/queue/next?src=${deps.source}`, { signal: AbortSignal.timeout(4000) });
      queued = (await res.json()) as { taskId?: string; taskText?: string };
    } catch (error) {
      return `idle (queue fetch failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    if (queued?.taskId && queued.taskText) {
      await deps.showPanel().catch(() => undefined);
      await deps.runTask(queued.taskId, queued.taskText, backendUrl);
      return 'started';
    }
    return `idle (queue empty)`;
  } finally {
    busy = false;
  }
}

export function defaultRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(
    () => createDriver((message) => handleMessage(message, { tabs: chrome.tabs, scripting: chrome.scripting })),
    'sw',
  );
}

// panel variant: same worker loop, but the driver talks through normal
// extension messaging (the panel page provably reaches the backend) - keeps
// autonomous runs alive while the side panel is open
export function panelRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(() => createExtensionDriver(), 'panel');
}

function remoteDepsForDriver(makeDriver: () => ReturnType<typeof createDriver>, source: string): RemoteDeps {
  return {
    source,
    // fetch must be wrapped: storing the naked global and calling it later
    // detaches it from its receiver and Chrome throws "Illegal invocation"
    fetchFn: (url, init) => fetch(url, init),
    reload: () => chrome.runtime.reload(),
    getBackend: () => getBackendUrl(chromeArea()),
    getWorkerEnabled: () => isRemoteWorkerEnabled(chromeArea()),
    saveWorkerEnabled: (enabled) => saveRemoteWorkerEnabled(enabled, chromeArea()),
    showPanel: openExtensionPanel,
    runTask: async (taskId, taskText, backendUrl) => {
      const provider = await resolveActiveProvider(createProductStore(chromeArea()));
      if (!provider) {
        await fetch(`${backendUrl}/tasks/${taskId}/finish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'failed', reason: 'no llm provider configured', stepCount: 0 }),
        }).catch(() => undefined);
        return;
      }
      await runRemoteTask(taskId, taskText, backendUrl, { provider, driver: makeDriver() });
    },
  };
}

// a remote run should be visible without the user clicking the toolbar icon;
// the real side panel needs a user gesture, so fall back to the panel page
// as a tab (which the service worker may always open)
export async function openExtensionPanel(): Promise<void> {
  try {
    const windowId = (await chrome.windows.getLastFocused()).id;
    await chrome.sidePanel.open({ windowId });
    return;
  } catch {
    // gesture error - continue with the tab fallback
  }
  const url = chrome.runtime.getURL('sidepanel.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id!, { active: true });
    if (existing[0].windowId !== undefined) await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url });
}
