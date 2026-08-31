import { useEffect, useRef, useState } from 'react';
import SettingsView from './SettingsView';
import TaskRunner from './TaskRunner';
import { useProviders } from './useProviders';
import { maybeRunRemoteWork, panelRemoteDeps } from '@/core/remote/worker';
import { getBackendUrl } from '@/core/telemetry/settings';

export default function App() {
  const [view, setView] = useState<'task' | 'settings'>('task');
  const { store, configs, refresh } = useProviders();
  const [remoteState, setRemoteState] = useState('idle');
  const [backendState, setBackendState] = useState('checking backend…');
  const baseDeps = useRef(panelRemoteDeps());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      let url = 'unknown';
      try {
        url = await getBackendUrl();
        const res = await fetch(`${url}/control/reload`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!cancelled) setBackendState(`backend ok · ${url}`);
      } catch (error) {
        if (!cancelled) {
          setBackendState(`backend unreachable · ${url} · ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const outcome = await maybeRunRemoteWork(baseDeps.current);
        if (!cancelled && outcome === 'started') setRemoteState('claimed a queued task');
      } catch (error) {
        if (!cancelled) setBackendState(`worker error · ${error instanceof Error ? error.message : String(error)}`);
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
    const deps = {
      ...baseDeps.current,
      runTask: async (taskId: string, taskText: string, backendUrl: string) => {
        setRemoteState(`running queued task: ${taskText.slice(0, 40)}`);
        try {
          await baseDeps.current.runTask(taskId, taskText, backendUrl);
        } finally {
          setRemoteState('idle');
        }
      },
    };
    baseDeps.current = deps;
  }, []);

  return (
    <main className="app">
      <header className="top">
        <h1 className="brand">web-robot</h1>
        <nav>
          <button className={view === 'task' ? 'tab on' : 'tab'} onClick={() => setView('task')}>
            task
          </button>
          <button className={view === 'settings' ? 'tab on' : 'tab'} onClick={() => setView('settings')}>
            settings
          </button>
          <button className="tab" title="restart the extension after a rebuild" onClick={() => chrome.runtime.reload()}>
            ⟳
          </button>
        </nav>
      </header>
      {remoteState !== 'idle' && <div className="note ok small">{remoteState}</div>}
      {view === 'task' ? <TaskRunner store={store} /> : <SettingsView store={store} configs={configs} refresh={refresh} />}
      <footer className="muted small backend-state">{backendState}</footer>
    </main>
  );
}
