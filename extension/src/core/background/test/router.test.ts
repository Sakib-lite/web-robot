import { describe, expect, it, vi } from 'vitest';
import { handleMessage, navigableUrl } from '../router';
import type { ContentRequest, ContentResponse } from '../../messaging/protocol';
import type { Snapshot } from '../../driver/types';

const snapshot: Snapshot = { url: 'https://shop.dev', title: 'Shop', text: 'hi', elements: [] };

function fakeTabs(over: Partial<Record<'query' | 'sendMessage' | 'update' | 'create' | 'remove' | 'reload' | 'get', (...args: never[]) => unknown>> = {}) {
  return {
    query: async () => [] as chrome.tabs.Tab[],
    sendMessage: async () => undefined,
    update: async () => ({}) as chrome.tabs.Tab,
    create: async () => ({ id: 9 }) as chrome.tabs.Tab,
    remove: async () => undefined,
    reload: async () => undefined,
    get: async () => ({ id: 7, status: 'complete', url: 'https://t.dev' }) as chrome.tabs.Tab,
    ...over,
  } as unknown as typeof chrome.tabs;
}

const fakeScripting = (executeScript: (...args: never[]) => unknown = vi.fn()) => ({ executeScript }) as unknown as typeof chrome.scripting;

function tabResponse(handler: (message: ContentRequest) => ContentResponse) {
  return async (_tabId: number, message: ContentRequest) => handler(message);
}

describe('navigableUrl', () => {
  it('accepts http, https and about:blank', () => {
    expect(navigableUrl('https://x.dev')).toBe('https://x.dev/');
    expect(navigableUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(navigableUrl('about:blank')).toBe('about:blank');
  });

  it('rejects other schemes and garbage', () => {
    expect(navigableUrl('javascript:alert(1)')).toBeNull();
    expect(navigableUrl('file:///etc/passwd')).toBeNull();
    expect(navigableUrl('chrome://settings')).toBeNull();
    expect(navigableUrl('not a url')).toBeNull();
  });
});

describe('handleMessage', () => {
  it('lists only http tabs and stars only the focused window\'s tab', async () => {
    const tabs = fakeTabs({
      query: async (queryInfo?: chrome.tabs.QueryInfo) => {
        const all = [
          { id: 1, url: 'https://a.dev', title: 'A', active: true },
          { id: 2, url: 'chrome://settings', title: 'Settings', active: false },
          { id: 3, url: 'https://b.dev', title: 'B', active: true },
        ];
        if (queryInfo?.lastFocusedWindow) return [all[0]];
        return all;
      },
    });
    const res = await handleMessage({ type: 'GET_TABS' }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({
      ok: true,
      tabs: [
        { id: 1, url: 'https://a.dev', title: 'A', active: true },
        { id: 3, url: 'https://b.dev', title: 'B', active: false },
      ],
    });
  });

  it('reuses an existing tab when new_tab targets the same url', async () => {
    const create = vi.fn(async () => ({ id: 9 }));
    const update = vi.fn(async () => ({}));
    const tabs = fakeTabs({
      query: async (queryInfo?: chrome.tabs.QueryInfo) => {
        if (queryInfo?.lastFocusedWindow) return [];
        return [{ id: 7, url: 'https://x.dev/page', title: 'X', active: false }];
      },
      create,
      update,
    });
    const res = await handleMessage({ type: 'RUN_ACTION', action: { type: 'new_tab', url: 'https://x.dev/page' } }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: true, detail: 'reused existing tab 7 at https://x.dev/page', data: { tabId: 7 } });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(7, { active: true });
  });

  it('returns a snapshot from the active tab', async () => {
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'https://shop.dev', title: 'Shop', active: true }],
      sendMessage: tabResponse((m) => (m.type === 'SNAPSHOT' ? { ok: true, snapshot } : { ok: true })),
    });
    const res = await handleMessage({ type: 'GET_SNAPSHOT' }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: true, snapshot });
  });

  it('injects the content script when the tab has none yet', async () => {
    let injected = false;
    const executeScript = vi.fn(() => {
      injected = true;
    });
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'https://shop.dev', title: 'Shop', active: true }],
      sendMessage: async (_tabId, message: ContentRequest) => {
        if (message.type === 'PING') return injected ? { ok: true } : Promise.reject(new Error('no receiver'));
        if (message.type === 'SNAPSHOT') return { ok: true, snapshot };
        return { ok: true };
      },
    });
    const res = await handleMessage({ type: 'GET_SNAPSHOT' }, { tabs, scripting: fakeScripting(executeScript) });
    expect(res.ok).toBe(true);
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content-scripts/content.js'] });
  });

  it('refuses to read non-http pages', async () => {
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'chrome://settings', title: 'Settings', active: true }],
    });
    const res = await handleMessage({ type: 'GET_SNAPSHOT' }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('cannot read this page') });
  });

  it('navigates the active tab and rejects unsafe urls', async () => {
    const update = vi.fn(async () => ({}));
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'https://old.dev', title: 'Old', active: true }],
      update,
    });
    const res = await handleMessage({ type: 'RUN_ACTION', action: { type: 'goto', url: 'https://new.dev' } }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: true, detail: 'navigated to https://new.dev/', data: { tabId: 7 } });
    expect(update).toHaveBeenCalledWith(7, { url: 'https://new.dev/' });

    const bad = await handleMessage({ type: 'RUN_ACTION', action: { type: 'goto', url: 'javascript:alert(1)' } }, { tabs, scripting: fakeScripting() });
    expect(bad.ok).toBe(false);
  });

  it('reloads instead of navigating when the active tab is already at the url', async () => {
    const reload = vi.fn(async () => undefined);
    const update = vi.fn(async () => ({}));
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'https://same.dev/page', title: 'Same', active: true }],
      update,
      reload,
    });
    const res = await handleMessage({ type: 'RUN_ACTION', action: { type: 'goto', url: 'https://same.dev/page' } }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: true, detail: 'reloaded https://same.dev/page (fresh page state)', data: { tabId: 7 } });
    expect(reload).toHaveBeenCalledWith(7);
    expect(update).not.toHaveBeenCalled();
  });

  it('opens, switches and closes tabs without needing an active tab', async () => {
    const create = vi.fn(async () => ({ id: 9 }));
    const update = vi.fn(async () => ({}));
    const remove = vi.fn(async () => undefined);
    const tabs = fakeTabs({ query: async () => [], create, update, remove });

    expect(await handleMessage({ type: 'RUN_ACTION', action: { type: 'new_tab', url: 'https://x.dev' } }, { tabs, scripting: fakeScripting() })).toEqual({
      ok: true,
      detail: 'opened tab 9 at https://x.dev/',
      data: { tabId: 9 },
    });
    expect(await handleMessage({ type: 'RUN_ACTION', action: { type: 'switch_tab', tabId: 4 } }, { tabs, scripting: fakeScripting() })).toEqual({
      ok: true,
      detail: 'switched to tab 4',
    });
    expect(await handleMessage({ type: 'RUN_ACTION', action: { type: 'close_tab', tabId: 4 } }, { tabs, scripting: fakeScripting() })).toEqual({
      ok: true,
      detail: 'closed tab 4',
    });
  });

  it('reports missing tabs on switch and close', async () => {
    const update = async () => {
      throw new Error('no tab');
    };
    const remove = async () => {
      throw new Error('no tab');
    };
    const tabs = fakeTabs({ update, remove });
    expect((await handleMessage({ type: 'RUN_ACTION', action: { type: 'switch_tab', tabId: 99 } }, { tabs, scripting: fakeScripting() })).ok).toBe(false);
    expect((await handleMessage({ type: 'RUN_ACTION', action: { type: 'close_tab', tabId: 99 } }, { tabs, scripting: fakeScripting() })).ok).toBe(false);
  });

  it('forwards page actions to the content script', async () => {
    const sendMessage = tabResponse((m) => (m.type === 'ACT' ? { ok: true, detail: 'clicked e1' } : { ok: true }));
    const tabs = fakeTabs({
      query: async () => [{ id: 7, url: 'https://shop.dev', title: 'Shop', active: true }],
      sendMessage,
    });
    const res = await handleMessage({ type: 'RUN_ACTION', action: { type: 'click', ref: 'e1' } }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: true, detail: 'clicked e1' });
  });

  it('rejects unknown message types', async () => {
    const res = await handleMessage({ type: 'EXPLODE' } as never, { tabs: fakeTabs(), scripting: fakeScripting() });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('unknown message type') });
  });
});


describe('task-bound tab targeting', () => {
  it('targets the given tabId instead of the active tab', async () => {
    const sendMessage = tabResponse((): ContentResponse => ({ ok: true, snapshot: { url: 'https://pinned.dev', title: 'P', text: 'x', elements: [] } }));
    const get = vi.fn(async () => ({ id: 42, status: 'complete', url: 'https://pinned.dev' }));
    const tabs = fakeTabs({ get, sendMessage });
    const res = await handleMessage({ type: 'GET_SNAPSHOT', tabId: 42 }, { tabs, scripting: fakeScripting() });
    expect(res.ok).toBe(true);
    expect(get).toHaveBeenCalledWith(42);
  });

  it('reports a gone task tab instead of drifting to the active one', async () => {
    const get = vi.fn(async () => {
      throw new Error('no tab');
    });
    const tabs = fakeTabs({ get });
    const res = await handleMessage({ type: 'GET_SNAPSHOT', tabId: 42 }, { tabs, scripting: fakeScripting() });
    expect(res).toEqual({ ok: false, error: 'task tab 42 no longer exists' });
  });
});

function fakeDebugger(over: Partial<Record<'attach' | 'detach' | 'sendCommand', (...args: never[]) => unknown>> = {}) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const api = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params });
      return {};
    }),
    onDetach: { addListener: vi.fn() },
    ...over,
  };
  return { api: api as unknown as typeof chrome.debugger, commands };
}

function activeTabs(over: Partial<Record<'query' | 'sendMessage' | 'captureVisibleTab' | 'update', (...args: never[]) => unknown>> = {}) {
  return fakeTabs({
    query: async () => [{ id: 7, url: 'https://t.dev', title: 'T', active: true, windowId: 3 }],
    sendMessage: async () => ({ ok: true }) as ContentResponse,
    ...over,
  });
}

describe('cdp actions', () => {
  it('presses keys as trusted input through the debugger', async () => {
    const dbg = fakeDebugger();
    const res = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'press', key: 'Enter', modifiers: ['control'] } },
      { tabs: activeTabs(), scripting: fakeScripting(), debugger: dbg.api },
    );
    expect(res).toEqual({ ok: true, detail: 'pressed Enter (trusted)' });
    const methods = dbg.commands.map((c) => c.method);
    expect(methods).toEqual(['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(dbg.commands[0]!.params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r', modifiers: 2 });
    expect(dbg.commands[1]!.params).toMatchObject({ type: 'keyUp', key: 'Enter' });
  });

  it('falls back to the content script when the debugger cannot attach', async () => {
    const dbg = fakeDebugger({ attach: vi.fn(async () => {
      throw new Error('cannot access');
    }) as never });
    const sendMessage = tabResponse((message) => {
      if (message.type === 'ACT') return { ok: true, detail: `pressed ${message.action.type === 'press' ? message.action.key : 'x'}` };
      return { ok: true };
    });
    const tabs = activeTabs({ sendMessage });
    const res = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'press', key: 'Enter' } },
      { tabs, scripting: fakeScripting(), debugger: dbg.api },
    );
    expect(res).toEqual({ ok: true, detail: 'pressed Enter' });
  });

  it('trusted-clicks at the element center after resolving its rect', async () => {
    const dbg = fakeDebugger();
    const sendMessage = tabResponse((message) => {
      if (message.type === 'RECT') return { ok: true, rect: { x: 10, y: 20, w: 100, h: 40 } };
      return { ok: true };
    });
    const res = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'click', ref: 'e3', trusted: true } },
      { tabs: activeTabs({ sendMessage }), scripting: fakeScripting(), debugger: dbg.api },
    );
    expect(res).toEqual({ ok: true, detail: 'trusted clicked e3' });
    expect(dbg.commands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed')!.params).toMatchObject({ x: 60, y: 40 });
  });

  it('clicks at viewport coordinates and hovers by ref', async () => {
    const dbg = fakeDebugger();
    const sendMessage = tabResponse((message) => {
      if (message.type === 'RECT') return { ok: true, rect: { x: 0, y: 0, w: 10, h: 10 } };
      return { ok: true };
    });
    const tabs = activeTabs({ sendMessage });
    await handleMessage({ type: 'RUN_ACTION', action: { type: 'click_at', x: 120, y: 55 } }, { tabs, scripting: fakeScripting(), debugger: dbg.api });
    await handleMessage({ type: 'RUN_ACTION', action: { type: 'hover', ref: 'e1' } }, { tabs, scripting: fakeScripting(), debugger: dbg.api });
    expect(dbg.commands.find((c) => c.params?.type === 'mousePressed')!.params).toMatchObject({ x: 120, y: 55 });
    expect(dbg.commands.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseMoved' && c.params?.y === 5)).toBe(true);
  });

  it('evaluates javascript in the page and surfaces exceptions', async () => {
    const ok = fakeDebugger({ sendCommand: vi.fn(async () => ({ result: { value: { answer: 42 } } })) as never });
    const res = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'evaluate_js', expression: 'window.__x' } },
      { tabs: activeTabs(), scripting: fakeScripting(), debugger: ok.api },
    );
    expect(res).toMatchObject({ ok: true, detail: '{"answer":42}' });

    const bad = fakeDebugger({ sendCommand: vi.fn(async () => ({ exceptionDetails: { text: 'SyntaxError', exception: { description: 'unexpected token' } } })) as never });
    const res2 = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'evaluate_js', expression: 'x x' } },
      { tabs: activeTabs(), scripting: fakeScripting(), debugger: bad.api },
    );
    expect(res2).toMatchObject({ ok: false });
    if (!res2.ok) expect(res2.error).toContain('SyntaxError');
  });

  it('captures a viewport screenshot and returns the data url', async () => {
    const dbg = fakeDebugger();
    const tabs = activeTabs({ captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,AAA') as never });
    const res = await handleMessage(
      { type: 'RUN_ACTION', action: { type: 'screenshot' } },
      { tabs, scripting: fakeScripting(), debugger: dbg.api },
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect((res.data as { dataUrl: string }).dataUrl).toBe('data:image/jpeg;base64,AAA');
  });
});
