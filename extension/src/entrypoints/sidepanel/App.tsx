import { useEffect, useRef, useState } from 'react';
import SettingsView from './SettingsView';
import TaskRunner, { type RunState } from './TaskRunner';
import { useProviders } from './useProviders';
import { maybeRunRemoteWork, panelRemoteDeps } from '@/core/remote/worker';
import { getBackendUrl } from '@/core/telemetry/settings';

export default function App() {
  const [view, setView] = useState<'task' | 'settings'>('task');
  const { store, configs, refresh } = useProviders();
  const [remoteState, setRemoteState] = useState('idle');
  const [backendState, setBackendState] = useState('checking backend…');
  const [manualRun, setManualRun] = useState<RunState | null>(null);
  const baseDeps = useRef(panelRemoteDeps());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      let url = 'unknown';
      try {
        url = await getBackendUrl();
        // /control/reload is consume-once (the worker's reload handshake) -
        // the health check must never eat that flag, so probe the queue instead
        const res = await fetch(`${url}/queue/depth`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!cancelled) setBackendState(`backend ok · ${url}`);
      } catch (error) {
        if (!cancelled) {
          setBackendState(`backend unreachable · ${url} · ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      let outcome = '?';
      try {
        outcome = await maybeRunRemoteWork(baseDeps.current);
      } catch (error) {
        outcome = `worker threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!cancelled) {
        setBackendState((prev) => (prev.startsWith('backend unreachable') || prev.startsWith('worker') ? prev : `backend ok · ${url} · worker: ${outcome}`));
        if (outcome === 'started') setRemoteState('claimed a queued task');
      }
    }

    const timer = setInterval(() => void poll(), 5000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const unwrapped = baseDeps.current;
    baseDeps.current = {
      ...unwrapped,
      runTask: async (taskId: string, taskText: string, backendUrl: string, skill?: string, model?: string, effort?: string) => {
        setRemoteState(`claimed queued task: ${taskText.slice(0, 50)}`);
        try {
          await unwrapped.runTask(taskId, taskText, backendUrl, skill, model, effort);
          setRemoteState(`task finished · trace ${taskId.slice(0, 8)}`);
        } catch (error) {
          setRemoteState(`claim error (stays until next claim): ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    };
  }, []);

  const remoteRunning = remoteState.startsWith('claimed');
  const running = manualRun !== null || remoteRunning;
  const runningLabel = manualRun
    ? `running · step ${manualRun.stepCount}`
    : remoteRunning
      ? 'remote task running'
      : '';
  const runningHint = manualRun?.snippet || remoteState;

  return (
    <main className="app">
      <header className="top">
        <div className="brand-wrap">
          <span className="logo" aria-hidden />
          <h1 className="brand">web-robot</h1>
          {running && (
            <span className="running-pill" title={runningHint}>
              <span className="spinner" aria-hidden />
              {runningLabel}
            </span>
          )}
        </div>
        <nav>
          <button className={view === 'task' ? 'tab on' : 'tab'} onClick={() => setView('task')}>
            task
          </button>
          <button className={view === 'settings' ? 'tab on' : 'tab'} onClick={() => setView('settings')}>
            settings
          </button>
          <button className="tab icon" title="restart the extension after a rebuild" onClick={() => chrome.runtime.reload()}>
            ⟳
          </button>
        </nav>
      </header>
      {remoteState !== 'idle' && !remoteRunning && <div className="note ok small">{remoteState}</div>}
      {view === 'task' ? (
        <TaskRunner store={store} configs={configs} onRunningChange={setManualRun} />
      ) : (
        <SettingsView store={store} configs={configs} refresh={refresh} />
      )}
      <footer className="muted small backend-state">
        <span className={backendState.startsWith('backend ok') ? 'dot ok' : 'dot err'} aria-hidden />
        {backendState}
      </footer>
    </main>
  );
}
