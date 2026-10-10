import { useEffect, useRef, useState } from 'react';
import SettingsView from './SettingsView';
import TaskRunner, { type RunState } from './TaskRunner';
import { useProviders } from './useProviders';
import { maybeRunRemoteWork, panelRemoteDeps } from '@/core/remote/worker';
import { getBackendUrl } from '@/core/telemetry/settings';

export default function App() {
  const [view, setView] = useState<'task' | 'settings'>('task');
  const { store, configs, customModels, refresh } = useProviders();
  const [remoteState, setRemoteState] = useState('idle');
  const [backendError, setBackendError] = useState<string | null>(null);
  const [manualRun, setManualRun] = useState<RunState | null>(null);
  const baseDeps = useRef(panelRemoteDeps());
  const promptedAsk = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      let url = 'unknown';
      let error: string | null = null;
      try {
        url = await getBackendUrl();
        const res = await fetch(`${url}/queue/depth`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (error_) {
        error = `backend unreachable · ${url} · ${error_ instanceof Error ? error_.message : String(error_)}`;
      }

      if (!error) {
        try {
          const res = await fetch(`${url}/asks/pending`, { signal: AbortSignal.timeout(4000) });
          if (res.ok) {
            const q = (await res.json()) as { id: number; taskId: number; question: string } | null;
            if (q && q.id !== promptedAsk.current) {
              promptedAsk.current = q.id;
              const answer = window.prompt(`web-robot asks (task #${q.taskId} is waiting):\n${q.question}`);
              if (answer !== null && answer.trim()) {
                await fetch(`${url}/asks/${q.id}/answer`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ answer: answer.trim() }),
                }).catch(() => undefined);
              }
            }
          }
        } catch {
        }
      }

      let outcome = '';
      if (!error) {
        try {
          outcome = await maybeRunRemoteWork(baseDeps.current);
        } catch (error_) {
          outcome = `worker threw: ${error_ instanceof Error ? error_.message : String(error_)}`;
        }
        if (/worker threw|fetch failed|no backend url/.test(outcome)) error = outcome;
      }
      if (!cancelled) setBackendError((prev) => (prev === error ? prev : error));
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    const timer = setInterval(() => void poll(), 5000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const unwrapped = baseDeps.current;
    baseDeps.current = {
      ...unwrapped,
      runTask: async (claim: { taskId: number; taskText: string }, backendUrl: string) => {
        setRemoteState(`claimed queued task: ${claim.taskText.slice(0, 50) || `#${claim.taskId} (continuation)`}`);
        try {
          await unwrapped.runTask(claim, backendUrl);
          setRemoteState(`task finished · trace #${claim.taskId}`);
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
        <TaskRunner store={store} configs={configs} customModels={customModels} onRunningChange={setManualRun} />
      ) : (
        <SettingsView store={store} configs={configs} customModels={customModels} refresh={refresh} />
      )}
      {backendError && (
        <footer className="muted small backend-state">
          <span className="dot err" aria-hidden />
          {backendError}
        </footer>
      )}
    </main>
  );
}
