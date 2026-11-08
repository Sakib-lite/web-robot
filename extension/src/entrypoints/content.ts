export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'PING') {
        sendResponse({ ok: true, url: location.href });
        return;
      }
      sendResponse({ ok: false, error: `unknown message type: ${message?.type}` });
    });
  },
});
