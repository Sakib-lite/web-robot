import { useEffect, useState } from 'react';
import SettingsView from './SettingsView';
import TaskRunner from './TaskRunner';
import { useProviders } from './useProviders';
import { maybeRunRemoteWork, panelRemoteDeps } from '@/core/remote/worker';

export default function App() {
  const [view, setView] = useState<'task' | 'settings'>('task');
  const { store, configs, refresh } = useProviders();
  const [remoteState, setRemoteState] = useState<string>('idle');

  useEffect(() => {
    const deps = {
      ...panelRemoteDeps(),
      runTask: async (taskId: string, taskText: string, backendUrl: string) => {
        setRemoteState(`running queued task: ${taskText.slice(0, 40)}`);
        try {
          await panelRemoteDeps().runTask(taskId, taskText, backendUrl);
        } finally {
          setRemoteState('idle');
        }
      },
    };
    const timer = setInterval(() => void maybeRunRemoteWork(deps), 5000);
    void maybeRunRemoteWork(deps);
    return () => clearInterval(timer);
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
    </main>
  );
}
