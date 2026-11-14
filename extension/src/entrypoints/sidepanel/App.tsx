import { useState } from 'react';
import SettingsView from './SettingsView';
import TaskRunner from './TaskRunner';
import { useProviders } from './useProviders';

export default function App() {
  const [view, setView] = useState<'task' | 'settings'>('task');
  const { store, configs, refresh } = useProviders();

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
        </nav>
      </header>
      {view === 'task' ? <TaskRunner store={store} /> : <SettingsView store={store} configs={configs} refresh={refresh} />}
    </main>
  );
}
