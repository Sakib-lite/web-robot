import { handleMessage } from '../background/router';
import { createDriver, createExtensionDriver } from '../driver/extensionDriver';
import { resolveActiveProvider, createProductStore } from '../llm/providers';
import { chromeArea } from '../storage/area';
import { runRemoteTask } from '../telemetry/client';
import { getBackendUrl } from '../telemetry/settings';

export interface RemoteDeps {
  fetchFn: typeof fetch;
  reload: () => void;
  runTask: (taskId: string, taskText: string, backendUrl: string) => Promise<void>;
  getBackend: () => Promise<string>;
}

let busy = false;

export async function maybeRunRemoteWork(deps: RemoteDeps): Promise<'idle' | 'reloading' | 'started' | 'busy'> {
  if (busy) return 'busy';
  busy = true;
  try {
    const backendUrl = await deps.getBackend();

    let control: { reload?: boolean };
    try {
      control = (await (await deps.fetchFn(`${backendUrl}/control/reload`, { signal: AbortSignal.timeout(4000) })).json()) as {
        reload?: boolean;
      };
    } catch {
      return 'idle';
    }
    if (control?.reload) {
      deps.reload();
      return 'reloading';
    }

    let queued: { taskId?: string; taskText?: string };
    try {
      queued = (await (await deps.fetchFn(`${backendUrl}/queue/next`, { signal: AbortSignal.timeout(4000) })).json()) as {
        taskId?: string;
        taskText?: string;
      };
    } catch {
      return 'idle';
    }
    if (queued?.taskId && queued.taskText) {
      await deps.runTask(queued.taskId, queued.taskText, backendUrl);
      return 'started';
    }
    return 'idle';
  } finally {
    busy = false;
  }
}

export function defaultRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(() =>
    createDriver((message) => handleMessage(message, { tabs: chrome.tabs, scripting: chrome.scripting })),
  );
}

// panel variant: same worker loop, but the driver talks through normal
// extension messaging (the panel page provably reaches the backend) - keeps
// autonomous runs alive while the side panel is open
export function panelRemoteDeps(): RemoteDeps {
  return remoteDepsForDriver(() => createExtensionDriver());
}

function remoteDepsForDriver(makeDriver: () => ReturnType<typeof createDriver>): RemoteDeps {
  return {
    fetchFn: fetch,
    reload: () => chrome.runtime.reload(),
    getBackend: () => getBackendUrl(chromeArea()),
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
