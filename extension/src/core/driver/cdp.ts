export type DebuggerApi = typeof chrome.debugger;
export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface Cdp {
  withDebugger<T>(tabId: number, fn: (send: CdpSend) => Promise<T>): Promise<T>;
  detachAll(): void;
}

const ATTACH_IDLE_MS = 30000;
const registry = new WeakMap<DebuggerApi, Cdp>();

export function cdpFor(debuggerApi: DebuggerApi): Cdp {
  const existing = registry.get(debuggerApi);
  if (existing) return existing;

  const attached = new Map<number, { idleTimer?: ReturnType<typeof setTimeout> }>();

  function forget(tabId: number): void {
    const entry = attached.get(tabId);
    if (!entry) return;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    attached.delete(tabId);
  }

  function detachQuiet(tabId: number): void {
    void debuggerApi.detach({ tabId }).catch(() => undefined);
  }

  function scheduleDetach(tabId: number): void {
    const entry = attached.get(tabId);
    if (!entry) return;
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      forget(tabId);
      detachQuiet(tabId);
    }, ATTACH_IDLE_MS);
  }

  const cdp: Cdp = {
    async withDebugger(tabId, fn) {
      if (!attached.has(tabId)) {
        try {
          await debuggerApi.attach({ tabId }, '1.3');
        } catch (err) {
          if (String(err).includes('already attached')) {
            throw new Error(`another debugger client already holds tab ${tabId} (close DevTools on it)`);
          }
          throw err;
        }
        attached.set(tabId, {});
      }
      try {
        return await fn((method, params) => debuggerApi.sendCommand({ tabId }, method, params));
      } finally {
        scheduleDetach(tabId);
      }
    },
    detachAll() {
      for (const tabId of Array.from(attached.keys())) {
        forget(tabId);
        detachQuiet(tabId);
      }
    },
  };

  debuggerApi.onDetach.addListener((source) => {
    if (source.tabId !== undefined) forget(source.tabId);
  });
  registry.set(debuggerApi, cdp);
  return cdp;
}
