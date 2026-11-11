import { startBackground } from '@/core/background/router';

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  startBackground();
});
