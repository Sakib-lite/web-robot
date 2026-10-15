import type { PanelRequest, PanelResponse } from '../messaging/protocol';
import type { Driver } from './types';

export type Sender = (message: PanelRequest) => Promise<PanelResponse>;

export function createDriver(send: Sender): Driver {
  let sessionTabId: number | null = null;
  const deadline = <T>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after 15s - the page or extension may be reloading; try again`)), 15000)),
    ]);
  return {
    async tabs() {
      const res = await deadline(send({ type: 'GET_TABS' }), 'tab list');
      if (!res.ok) throw new Error(res.error);
      return res.tabs ?? [];
    },

    async snapshot(skip?: number) {
      const res = await deadline(
        send(sessionTabId !== null ? { type: 'GET_SNAPSHOT', skip, tabId: sessionTabId } : { type: 'GET_SNAPSHOT', ...(skip !== undefined ? { skip } : {}) }),
        'page snapshot',
      );
      if (!res.ok) throw new Error(res.error);
      if (!res.snapshot) throw new Error('no snapshot in response');
      return res.snapshot;
    },

    async act(action) {
      const res = await deadline(
        send(sessionTabId !== null ? { type: 'RUN_ACTION', action, tabId: sessionTabId } : { type: 'RUN_ACTION', action }),
        `action ${action.type}`,
      );
      if (res.ok) {
        if (action.type === 'new_tab' || action.type === 'goto') {
          const id = Number((res.data as { tabId?: number } | undefined)?.tabId);
          if (Number.isFinite(id)) sessionTabId = id;
        }
        if (action.type === 'switch_tab') sessionTabId = action.tabId;
        if (action.type === 'close_tab' && action.tabId === sessionTabId) sessionTabId = null;
      }
      if (!res.ok) return { ok: false, detail: res.error };
      return { ok: true, detail: res.detail ?? `${action.type} ok`, ...(res.data ? { data: res.data } : {}) };
    },
  };
}

export function createExtensionDriver(): Driver {
  return createDriver((message) => chrome.runtime.sendMessage(message));
}
