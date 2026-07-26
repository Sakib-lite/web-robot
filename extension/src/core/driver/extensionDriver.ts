import type { PanelRequest, PanelResponse } from '../messaging/protocol';
import type { Driver } from './types';

export type Sender = (message: PanelRequest) => Promise<PanelResponse>;

export function createDriver(send: Sender): Driver {
  return {
    async tabs() {
      const res = await send({ type: 'GET_TABS' });
      if (!res.ok) throw new Error(res.error);
      return res.tabs ?? [];
    },

    async snapshot() {
      const res = await send({ type: 'GET_SNAPSHOT' });
      if (!res.ok) throw new Error(res.error);
      if (!res.snapshot) throw new Error('no snapshot in response');
      return res.snapshot;
    },

    async act(action) {
      const res = await send({ type: 'RUN_ACTION', action });
      if (!res.ok) return { ok: false, detail: res.error };
      return { ok: true, detail: res.detail ?? `${action.type} ok` };
    },
  };
}

export function createExtensionDriver(): Driver {
  return createDriver((message) => chrome.runtime.sendMessage(message));
}
