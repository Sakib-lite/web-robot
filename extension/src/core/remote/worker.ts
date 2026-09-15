import { handleMessage } from '../background/router';
import { createDriver, createExtensionDriver } from '../driver/extensionDriver';
import { createHttpPlane } from '../local/httpPlane';
import { resolveActiveProvider, createProductStore } from '../llm/providers';
import { chromeArea } from '../storage/area';
import { runRemoteTask } from '../telemetry/client';
import { getBackendUrl, isRemoteWorkerEnabled, saveRemoteWorkerEnabled } from '../telemetry/settings';

export interface RemoteDeps {
  source: string;
  fetchFn: typeof fetch;
  reload: () => void;
  runTask: (taskId: string, taskText: string, backendUrl: string, skill?: string, model?: string, effort?: string) => Promise<void>;
  getBackend: () => Promise<string>;
  getWorkerEnabled: () => Promise<boolean>;
  saveWorkerEnabled: (enabled: boolean) => Promise<void>;
  showPanel: () => Promise<void>;
}

let busy = false;
let currentTaskId: string | null = null;

export async function maybeRunRemoteWork(deps: RemoteDeps): Promise<string> {
  let backendUrl: string;
  try {
    backendUrl = await deps.getBackend();
  } catch {
    return 'idle (no backend url)';
  }
  if (busy) {
    // keep heartbeating busy+currentTask during a run: the backend reaper
    // decides zombie-vs-alive from these, so silence would get the run requeued
    if (currentTaskId) {
      await deps
        .fetchFn(`${backendUrl}/worker/status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: deps.source, state: 'busy', currentTask: currentTaskId }),
          signal: AbortSignal.timeout(4000),
        })
        .catch(() => undefined);
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

    let queued: { taskId?: string; taskText?: string; skill?: string; model?: string; effort?: string };
    try {
      const res = await deps.fetchFn(`${backendUrl}/queue/next?src=${deps.source}`, { signal: AbortSignal.timeout(4000) });
      queued = (await res.json()) as { taskId?: string; taskText?: string };
    } catch (error) {
      return `idle (queue fetch failed: ${error instanceof Error ? error.message : String(error)})`;
    }
    if (queued?.taskId && queued.taskText) {
      await deps.showPanel().catch(() => undefined);
      await deps.runTask(queued.taskId, queued.taskText, backendUrl, queued.skill, queued.model, queued.effort);
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

async function runClaimedTask(
  taskId: string,
  taskText: string,
  backendUrl: string,
  skill: string | undefined,
  driver: ReturnType<typeof createDriver>,
  taskModel?: string,
  taskEffort?: string,
): Promise<void> {
  const active = await resolveActiveProvider(createProductStore(chromeArea()));
  if (!active) {
    await fetch(`${backendUrl}/tasks/${taskId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'failed', reason: 'no llm provider configured', stepCount: 0 }),
    }).catch(() => undefined);
    return;
  }
  let provider = active;
  // per-task overrides chosen at queue time win; a selected skill fills the
  // gaps and injects its body as a preamble
  if (taskModel) provider = { ...provider, model: taskModel };
  if (taskEffort) provider = { ...provider, thinking: taskEffort as 'off' | 'low' | 'high' | 'max' };
  let preamble: string | undefined;
  let maxSteps: number | undefined;
  if (skill) {
    try {
      const res = await fetch(`${backendUrl}/skills/${encodeURIComponent(skill)}`);
      if (res.ok) {
        const full = (await res.json()) as { name?: string; body?: string; defaults?: Record<string, string> };
        if (full.defaults?.model && !taskModel) provider = { ...provider, model: full.defaults.model };
        if (full.defaults?.effort && !taskEffort) provider = { ...provider, thinking: full.defaults.effort as 'off' | 'low' | 'high' | 'max' };
        if (full.defaults?.maxSteps) maxSteps = Number(full.defaults.maxSteps);
        if (full.body) preamble = `SKILL "${full.name ?? skill}" - follow this workflow for the whole task:\n\n${full.body}`.slice(0, 8000);
      }
    } catch {
      // a missing skill must not block the task - run without it
    }
  }
  // workspace hands are attached only when the backend actually offers
  // them; otherwise the run stays web-only and the file tools are absent
  const plane = createHttpPlane(async () => backendUrl);
  const info = await plane.describe().catch(() => null);
  await runRemoteTask(taskId, taskText, backendUrl, {
    provider,
    driver,
    ...(maxSteps ? { maxSteps } : {}),
    ...(preamble ? { preamble } : {}),
    ...(info?.enabled ? { workspace: { plane, root: info.root } } : {}),
  });
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
    runTask: async (taskId, taskText, backendUrl, skill, model, effort) => {
      currentTaskId = taskId;
      try {
        await runClaimedTask(taskId, taskText, backendUrl, skill, makeDriver(), model, effort);
      } finally {
        currentTaskId = null;
      }
    },
  };
}

// a remote run should be visible without the user clicking the toolbar icon;
// the real side panel needs a user gesture, so fall back to the panel page
// as a tab (which the service worker may always open)
export async function openExtensionPanel(): Promise<void> {
  try {
    const window = await chrome.windows.getLastFocused();
    if (window.id === undefined) throw new Error('no focused window');
    await chrome.sidePanel.open({ windowId: window.id });
    return;
  } catch {
    // gesture error - continue with the tab fallback
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
