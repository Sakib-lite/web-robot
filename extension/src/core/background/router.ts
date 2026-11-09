import type { Action } from '../driver/types';
import type { ContentRequest, ContentResponse, PanelRequest, PanelResponse } from '../messaging/protocol';
import { cdpFor, type Cdp, type DebuggerApi } from '../driver/cdp';
import { capture } from '../driver/capture';
import { modifiersMask, resolveKey } from '../driver/keys';

const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

type TabsApi = typeof chrome.tabs;
type ScriptingApi = typeof chrome.scripting;

export function navigableUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return url.href;
    return null;
  } catch {
    return null;
  }
}

async function resolveTab(tabsApi: TabsApi, tabId?: number): Promise<chrome.tabs.Tab | null> {
  if (tabId !== undefined) {
    try {
      const tab = await tabsApi.get(tabId);
      return tab ?? null;
    } catch {
      return null;
    }
  }
  return activeTab(tabsApi);
}

async function waitForComplete(tabsApi: TabsApi, tabId: number, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await tabsApi.get(tabId);
      if (tab?.status === 'complete') break;
    } catch {
      break;
    }
    await sleep(150);
  }
  await sleep(300);
}

async function activeTab(tabsApi: TabsApi): Promise<chrome.tabs.Tab | null> {
  const [current] = await tabsApi.query({ active: true, currentWindow: true });
  if (current) return current;
  const [any] = await tabsApi.query({ active: true });
  return any ?? null;
}

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function sendToTab(tabsApi: TabsApi, tabId: number, message: ContentRequest): Promise<ContentResponse> {
  try {
    const res = await withDeadline(tabsApi.sendMessage(tabId, message), 15000, `content script ${message.type}`);
    if (res && typeof res === 'object' && 'ok' in res) return res as ContentResponse;
    return { ok: false, error: 'content script returned nothing' };
  } catch (e) {
    const msg = e instanceof Error && e.message.includes('timed out') ? e.message : 'content script is not loaded in this tab';
    return { ok: false, error: msg };
  }
}

async function ensureInjected(tabsApi: TabsApi, scriptingApi: ScriptingApi, tabId: number): Promise<void> {
  const ping = await sendToTab(tabsApi, tabId, { type: 'PING' });
  if (ping.ok) return;
  await scriptingApi.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBrowserAction(tab: chrome.tabs.Tab | undefined, action: Action, tabsApi: TabsApi): Promise<PanelResponse> {
  switch (action.type) {
    case 'goto': {
      if (!tab?.id) return { ok: false, error: 'no active tab to navigate' };
      const url = navigableUrl(action.url);
      if (!url) return { ok: false, error: `not a navigable url: ${action.url}` };
      if (tab.url === url) {
        await tabsApi.reload(tab.id);
        await waitForComplete(tabsApi, tab.id);
        return { ok: true, detail: `reloaded ${url} (fresh page state)`, data: { tabId: tab.id } };
      }
      await tabsApi.update(tab.id, { url });
      await waitForComplete(tabsApi, tab.id);
      return { ok: true, detail: `navigated to ${url}`, data: { tabId: tab.id } };
    }
    case 'new_tab': {
      const url = action.url ? navigableUrl(action.url) : 'about:blank';
      if (!url) return { ok: false, error: `not a navigable url: ${action.url}` };
      const existing = ((await tabsApi.query({})) ?? []).find((t) => t.url === url && typeof t.id === 'number');
      if (existing?.id !== undefined) {
        await tabsApi.update(existing.id, { active: true });
        return { ok: true, detail: `reused existing tab ${existing.id} at ${url}`, data: { tabId: existing.id } };
      }
      const tab = await tabsApi.create({ url, active: true });
      await waitForComplete(tabsApi, tab.id as number);
      return { ok: true, detail: `opened tab ${tab.id} at ${url}`, data: { tabId: tab.id } };
    }
    case 'switch_tab': {
      try {
        await tabsApi.update(action.tabId, { active: true });
        return { ok: true, detail: `switched to tab ${action.tabId}` };
      } catch {
        return { ok: false, error: `tab ${action.tabId} does not exist` };
      }
    }
    case 'close_tab': {
      try {
        await tabsApi.remove(action.tabId);
        return { ok: true, detail: `closed tab ${action.tabId}` };
      } catch {
        return { ok: false, error: `tab ${action.tabId} does not exist` };
      }
    }
    default:
      return { ok: false, error: 'unsupported browser action' };
  }
}

export interface BrowserApis {
  tabs: TabsApi;
  scripting: ScriptingApi;
  debugger?: DebuggerApi;
}

const EVAL_RESULT_CHARS = 50000;

function clampInt(value: unknown, min: number, max: number, dflt: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return dflt;
  return Math.min(Math.max(Math.round(value), min), max);
}

async function rectFor(tabsApi: TabsApi, tabId: number, ref: string): Promise<{ x: number; y: number; w: number; h: number } | string> {
  const res = await sendToTab(tabsApi, tabId, { type: 'RECT', ref });
  if (!res.ok) return res.error;
  if (!res.rect) return 'content script returned no rect';
  return res.rect;
}

async function mouseClickAt(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>, x: number, y: number): Promise<void> {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function runCdpAction(
  tab: chrome.tabs.Tab,
  action: Action,
  apis: BrowserApis,
  cdp: Cdp,
): Promise<PanelResponse | null> {
  const tabId = tab.id as number;
  if (action.type === 'click' && action.trusted) {
    const rect = await rectFor(apis.tabs, tabId, action.ref);
    if (typeof rect === 'string') return { ok: false, error: rect };
    await cdp.withDebugger(tabId, (send) => mouseClickAt(send, rect.x + rect.w / 2, rect.y + rect.h / 2));
    return { ok: true, detail: `trusted clicked ${action.ref}` };
  }
  if (action.type === 'click_at') {
    await cdp.withDebugger(tabId, (send) => mouseClickAt(send, action.x, action.y));
    return { ok: true, detail: `trusted clicked at ${Math.round(action.x)},${Math.round(action.y)}` };
  }
  if (action.type === 'hover') {
    const rect = await rectFor(apis.tabs, tabId, action.ref);
    if (typeof rect === 'string') return { ok: false, error: rect };
    await cdp.withDebugger(tabId, (send) =>
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, button: 'none' }),
    );
    return { ok: true, detail: `hovered ${action.ref}` };
  }
  if (action.type === 'evaluate_js') {
    const raw = (await cdp.withDebugger(tabId, (send) =>
      send('Runtime.evaluate', {
        expression: action.expression,
        returnByValue: true,
        awaitPromise: action.awaitPromise !== false,
        timeout: 10000,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (raw.exceptionDetails) {
      const details = raw.exceptionDetails;
      return { ok: false, error: `${details.text}: ${details.exception?.description ?? ''}`.slice(0, 300) };
    }
    let serialized = JSON.stringify(raw.result?.value === undefined ? null : raw.result?.value) ?? 'null';
    if (serialized.length > EVAL_RESULT_CHARS) serialized = serialized.slice(0, EVAL_RESULT_CHARS) + '…[truncated]';
    return { ok: true, detail: serialized.slice(0, 800), data: { value: serialized } };
  }
  if (action.type === 'screenshot') {
    const shot = await capture(
      tab,
      {
        fullPage: action.fullPage === true,
        format: action.format === 'png' ? 'png' : 'jpeg',
        quality: clampInt(action.quality, 1, 100, 80),
        maxWidth: clampInt(action.maxWidth, 100, 4096, 1280),
      },
      {
        captureVisibleTab: (windowId, options) =>
          (apis.tabs.captureVisibleTab as unknown as (w: number, o: { format: string; quality: number }) => Promise<string>)(windowId, options),
        activateTab: async (id) => {
          await apis.tabs.update(id, { active: true });
        },
        fullPageCapture: (id, format, quality) =>
          cdp.withDebugger(id, (send) =>
            send('Page.captureScreenshot', { format, quality, captureBeyondViewport: true }),
          ).then((res) => {
            const data = (res as { data?: string }).data;
            if (!data) throw new Error('Page.captureScreenshot returned no image');
            return `data:image/${format};base64,${data}`;
          }),
      },
    );
    return { ok: true, detail: `${shot.width || '?'}x${shot.height || '?'} ${shot.dataUrl.length} chars`, data: shot };
  }
  if (action.type === 'press') {
    try {
      const def = resolveKey(action.key);
      const modifiers = Array.isArray(action.modifiers) ? modifiersMask(action.modifiers) : 0;
      await cdp.withDebugger(tabId, async (send) => {
        const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, nativeVirtualKeyCode: def.windowsVirtualKeyCode };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(def.text !== undefined ? { text: def.text, unmodifiedText: def.text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      });
      return { ok: true, detail: `pressed ${action.key} (trusted)` };
    } catch {
      return null;
    }
  }
  return null;
}

export async function handleMessage(message: PanelRequest, apis: BrowserApis): Promise<PanelResponse> {
  const { tabs: tabsApi, scripting: scriptingApi } = apis;

  if (message.type === 'GET_TABS') {
    const all = (await tabsApi.query({})) ?? [];
    const [focused] = await tabsApi.query({ active: true, lastFocusedWindow: true });
    const tabs = all
      .filter((t) => (t.url ?? '').startsWith('http') && typeof t.id === 'number')
      .map((t) => ({ id: t.id as number, url: t.url, title: t.title, active: !!focused && t.id === focused.id }));
    return { ok: true, tabs };
  }

  if (message.type === 'GET_SNAPSHOT') {
    const tab = await resolveTab(tabsApi, message.tabId);
    if (!tab?.id) return { ok: false, error: message.tabId !== undefined ? `task tab ${message.tabId} no longer exists` : 'no active tab' };
    if (!tab.url?.startsWith('http')) return { ok: false, error: `cannot read this page (${tab.url ?? 'unknown url'})` };
    await ensureInjected(tabsApi, scriptingApi, tab.id);
    const res = await sendToTab(tabsApi, tab.id, { type: 'SNAPSHOT', ...(message.skip !== undefined ? { skip: message.skip } : {}) });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.snapshot) return { ok: false, error: 'content script returned no snapshot' };
    return { ok: true, snapshot: res.snapshot };
  }

  if (message.type === 'RUN_ACTION') {
    const action = message.action;

    if (action.type === 'new_tab' || action.type === 'switch_tab' || action.type === 'close_tab') {
      return runBrowserAction(undefined, action, tabsApi);
    }

    if (action.type === 'wait') {
      await sleep(action.ms);
      return { ok: true, detail: `waited ${action.ms}ms` };
    }

    const tab = await resolveTab(tabsApi, message.tabId);
    if (!tab?.id) return { ok: false, error: message.tabId !== undefined ? `task tab ${message.tabId} no longer exists` : 'no active tab' };

    if (action.type === 'goto') {
      return runBrowserAction(tab, action, tabsApi);
    }

    if (!tab.url?.startsWith('http')) return { ok: false, error: `cannot act on this page (${tab.url ?? 'unknown url'})` };

    if (apis.debugger) {
      const cdpRes = await runCdpAction(tab, action, apis, cdpFor(apis.debugger));
      if (cdpRes) return cdpRes;
    }

    const CONTENT_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'scroll', 'wait', 'extract']);
    if (!CONTENT_ACTIONS.has(action.type)) {
      return { ok: false, error: `action ${action.type} needs the debugger, which is unavailable` };
    }
    const contentAction = action as Extract<Action, { type: 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'extract' }>;

    await ensureInjected(tabsApi, scriptingApi, tab.id);
    const res = await sendToTab(tabsApi, tab.id, { type: 'ACT', action: contentAction });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, detail: res.detail ?? `${action.type} done` };
  }

  return { ok: false, error: `unknown message type: ${(message as { type?: string }).type}` };
}

export function startBackground() {
  const apis: BrowserApis = { tabs: chrome.tabs, scripting: chrome.scripting, debugger: chrome.debugger };
  chrome.runtime.onMessage.addListener((message: PanelRequest, _sender, sendResponse) => {
    handleMessage(message, apis).then(sendResponse, (error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });
}
