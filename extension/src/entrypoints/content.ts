import { buildSnapshot, collectInteractive, elementForRef } from '@/core/driver/pageSnapshot';
import { runPageAction } from '@/core/driver/pageActions';
import type { ContentRequest, ContentResponse } from '@/core/messaging/protocol';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const resolveRef = (ref: string): Element | null => elementForRef(document, ref);

    chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
      if (message?.type === 'SNAPSHOT') {
        collectInteractive(document);
        sendResponse({ ok: true, snapshot: buildSnapshot(document, message.skip ?? 0) });
        return;
      }
      if (message?.type === 'RECT') {
        const el = resolveRef(message.ref);
        if (!el || !el.isConnected) {
          sendResponse({ ok: false, error: `ref ${message.ref} not found on the page - take a new snapshot` });
          return;
        }
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        sendResponse({ ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        return;
      }
      if (message?.type === 'ACT') {
        runPageAction(message.action, resolveRef, window).then((result) => {
          sendResponse(result.ok ? { ok: true, detail: result.detail } : { ok: false, error: result.detail });
        });
        return true;
      }
      if (message?.type === 'PING') {
        sendResponse({ ok: true, url: location.href });
        return;
      }
      sendResponse({ ok: false, error: `unknown message type: ${(message as { type?: string })?.type}` });
    });
  },
});
