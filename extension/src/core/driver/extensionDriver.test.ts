import { describe, expect, it } from 'vitest';
import { createDriver, type Sender } from './extensionDriver';
import type { PanelRequest, PanelResponse } from '../messaging/protocol';
import type { Snapshot } from './types';

const snapshot: Snapshot = { url: 'https://x.dev', title: 'X', text: '', elements: [] };

describe('createDriver', () => {
  it('unwraps successful responses', async () => {
    const send: Sender = async (message: PanelRequest): Promise<PanelResponse> => {
      if (message.type === 'GET_TABS') return { ok: true, tabs: [{ id: 1, url: 'https://x.dev', title: 'X', active: true }] };
      if (message.type === 'GET_SNAPSHOT') return { ok: true, snapshot };
      return { ok: true, detail: 'clicked e1' };
    };
    const driver = createDriver(send);

    expect(await driver.tabs()).toEqual([{ id: 1, url: 'https://x.dev', title: 'X', active: true }]);
    expect(await driver.snapshot()).toEqual(snapshot);
    expect(await driver.act({ type: 'click', ref: 'e1' })).toEqual({ ok: true, detail: 'clicked e1' });
  });

  it('maps errors: throws for reads, returns failed result for actions', async () => {
    const send: Sender = async () => ({ ok: false, error: 'no active tab' });
    const driver = createDriver(send);

    await expect(driver.tabs()).rejects.toThrow('no active tab');
    await expect(driver.snapshot()).rejects.toThrow('no active tab');
    expect(await driver.act({ type: 'click', ref: 'e1' })).toEqual({ ok: false, detail: 'no active tab' });
  });

  it('sends the action through untouched', async () => {
    const seen: PanelRequest[] = [];
    const send: Sender = async (message) => {
      seen.push(message);
      if (message.type === 'RUN_ACTION') return { ok: true, detail: 'ok' };
      if (message.type === 'GET_TABS') return { ok: true, tabs: [] };
      return { ok: true, snapshot };
    };
    const driver = createDriver(send);
    await driver.act({ type: 'goto', url: 'https://x.dev' });
    expect(seen).toEqual([{ type: 'RUN_ACTION', action: { type: 'goto', url: 'https://x.dev' } }]);
  });
});
