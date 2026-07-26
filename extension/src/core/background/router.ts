import type { Action } from '../driver/types';
import type { ContentRequest, ContentResponse, PanelRequest, PanelResponse } from '../messaging/protocol';

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

async function activeTab(tabsApi: TabsApi): Promise<chrome.tabs.Tab | null> {
  const [current] = await tabsApi.query({ active: true, currentWindow: true });
  if (current) return current;
  const [any] = await tabsApi.query({ active: true });
  return any ?? null;
}

async function sendToTab(tabsApi: TabsApi, tabId: number, message: ContentRequest): Promise<ContentResponse> {
  try {
    const res = await tabsApi.sendMessage(tabId, message);
    if (res && typeof res === 'object' && 'ok' in res) return res as ContentResponse;
    return { ok: false, error: 'content script returned nothing' };
  } catch {
    return { ok: false, error: 'content script is not loaded in this tab' };
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

async function runBrowserAction(tabId: number | undefined, action: Action, tabsApi: TabsApi): Promise<PanelResponse> {
  switch (action.type) {
    case 'goto': {
      if (!tabId) return { ok: false, error: 'no active tab to navigate' };
      const url = navigableUrl(action.url);
      if (!url) return { ok: false, error: `not a navigable url: ${action.url}` };
      await tabsApi.update(tabId, { url });
      await sleep(600);
      return { ok: true, detail: `navigated to ${url}` };
    }
    case 'new_tab': {
      const url = action.url ? navigableUrl(action.url) : 'about:blank';
      if (!url) return { ok: false, error: `not a navigable url: ${action.url}` };
      const tab = await tabsApi.create({ url, active: true });
      await sleep(600);
      return { ok: true, detail: `opened tab ${tab.id} at ${url}` };
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
}

export async function handleMessage(message: PanelRequest, apis: BrowserApis): Promise<PanelResponse> {
  const { tabs: tabsApi, scripting: scriptingApi } = apis;

  if (message.type === 'GET_TABS') {
    const all = await tabsApi.query({});
    const tabs = (all ?? [])
      .filter((t) => (t.url ?? '').startsWith('http') && typeof t.id === 'number')
      .map((t) => ({ id: t.id as number, url: t.url, title: t.title, active: !!t.active }));
    return { ok: true, tabs };
  }

  if (message.type === 'GET_SNAPSHOT') {
    const tab = await activeTab(tabsApi);
    if (!tab?.id) return { ok: false, error: 'no active tab' };
    if (!tab.url?.startsWith('http')) return { ok: false, error: `cannot read this page (${tab.url ?? 'unknown url'})` };
    await ensureInjected(tabsApi, scriptingApi, tab.id);
    const res = await sendToTab(tabsApi, tab.id, { type: 'SNAPSHOT' });
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

    const tab = await activeTab(tabsApi);
    if (!tab?.id) return { ok: false, error: 'no active tab' };

    if (action.type === 'goto') {
      return runBrowserAction(tab.id, action, tabsApi);
    }

    if (!tab.url?.startsWith('http')) return { ok: false, error: `cannot act on this page (${tab.url ?? 'unknown url'})` };
    await ensureInjected(tabsApi, scriptingApi, tab.id);
    const res = await sendToTab(tabsApi, tab.id, { type: 'ACT', action });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, detail: res.detail ?? `${action.type} done` };
  }

  return { ok: false, error: `unknown message type: ${(message as { type?: string }).type}` };
}

export function startBackground() {
  const apis: BrowserApis = { tabs: chrome.tabs, scripting: chrome.scripting };
  chrome.runtime.onMessage.addListener((message: PanelRequest, _sender, sendResponse) => {
    handleMessage(message, apis).then(sendResponse, (error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });
}
