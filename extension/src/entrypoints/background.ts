import { startBackground } from '@/core/background/router';
import { defaultRemoteDeps, maybeRunRemoteWork } from '@/core/remote/worker';

export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  startBackground();

  const deps = defaultRemoteDeps();
  setInterval(() => void maybeRunRemoteWork(deps), 10_000);
  void maybeRunRemoteWork(deps);
  try {
    chrome.alarms.create('web-robot-remote-poll', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'web-robot-remote-poll') void maybeRunRemoteWork(deps);
    });
  } catch {
  }
});
