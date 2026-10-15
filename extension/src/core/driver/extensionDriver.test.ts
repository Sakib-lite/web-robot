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


describe('task-bound session tab pinning', () => {
  it('pins the tab opened by new_tab and targets it afterwards; switch/close re-pin', async () => {
    const sent: unknown[] = [];
    const send = async (message: never) => {
      sent.push(message);
      const m = message as { type: string; action?: { type: string } };
      if (m.type === 'GET_SNAPSHOT') return { ok: true, snapshot: { url: 'https://a.dev', title: 'A', text: 'x', elements: [] } };
      if (m.type === 'RUN_ACTION' && m.action?.type === 'new_tab') return { ok: true, detail: 'opened', data: { tabId: 9 } };
      if (m.type === 'RUN_ACTION' && m.action?.type === 'switch_tab') return { ok: true, detail: 'switched' };
      if (m.type === 'RUN_ACTION' && m.action?.type === 'close_tab') return { ok: true, detail: 'closed' };
      return { ok: true, detail: 'ok' };
    };
    const driver = createDriver(send as never);
    await driver.act({ type: 'new_tab', url: 'https://a.dev' });
    await driver.snapshot();
    expect(sent[1]).toMatchObject({ type: 'GET_SNAPSHOT', tabId: 9 });

    await driver.act({ type: 'switch_tab', tabId: 4 });
    await driver.snapshot();
    expect(sent[3]).toMatchObject({ type: 'GET_SNAPSHOT', tabId: 4 });

    await driver.act({ type: 'close_tab', tabId: 4 });
    await driver.snapshot();
    expect(sent[5]).not.toHaveProperty('tabId');
  });
});
