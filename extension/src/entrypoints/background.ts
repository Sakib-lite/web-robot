export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: `unknown message type: ${message?.type}` });
  });
});
