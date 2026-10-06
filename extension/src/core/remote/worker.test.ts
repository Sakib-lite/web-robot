import { describe, expect, it, vi } from 'vitest';
import { maybeRunRemoteWork, type RemoteDeps } from './worker';

function jsonResponder(routes: Record<string, unknown>) {
  return (async (url: string | URL | Request) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const handler = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (handler === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(handler), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function deps(over: Partial<RemoteDeps> = {}): RemoteDeps {
  return {
    source: 'test',
    fetchFn: jsonResponder({}),
    reload: vi.fn(),
    getBackend: async () => 'http://backend.test',
    runTask: vi.fn(async () => {}),
    getWorkerEnabled: async () => true,
    saveWorkerEnabled: vi.fn(async () => {}),
    showPanel: vi.fn(async () => {}),
    ...over,
  };
}

describe('maybeRunRemoteWork', () => {
  it('stays idle when the backend is unreachable', async () => {    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await maybeRunRemoteWork(deps({ fetchFn }))).toContain('control fetch failed');
  });

  it('reloads when the backend requests it', async () => {
    const reload = vi.fn();
    const fetchFn = jsonResponder({ '/control/reload': { reload: true } });
    expect(await maybeRunRemoteWork(deps({ fetchFn, reload }))).toBe('reloading');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('claims a queued task and runs it', async () => {
    const runTask = vi.fn(async () => {});
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'list repos' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask }))).toBe('started');
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 7, taskText: 'list repos' }), 'http://backend.test');
  });

  it('passes an attached context slug through to the runner', async () => {
    const runTask = vi.fn(async () => {});
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'find jobs for this profile', context: 'profile-context-professional' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask }))).toBe('started');
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 7, taskText: 'find jobs for this profile', context: 'profile-context-professional' }), 'http://backend.test');
  });

  it('shows the panel when a task is claimed, even if it fails', async () => {
    const runTask = vi.fn(async () => {});
    const showPanel = vi.fn(async () => { throw new Error('gesture required'); });
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'list repos' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask, showPanel }))).toBe('started');
    expect(showPanel).toHaveBeenCalledOnce();
    expect(runTask).toHaveBeenCalledOnce();
  });

  it('ignores an empty queue', async () => {
    const runTask = vi.fn(async () => {});
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': {},
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask }))).toBe('idle (queue empty)');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('stays off when disabled in settings and reports that to the backend', async () => {
    const runTask = vi.fn(async () => {});
    const posts: string[] = [];
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'should not run' },
    });
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('/worker/status')) posts.push(String(init.body));
      return fetchFn(url, init);
    }) as unknown as typeof fetch;
    expect(await maybeRunRemoteWork(deps({ fetchFn: wrapped, runTask, getWorkerEnabled: async () => false }))).toBe('off (disabled in settings)');
    expect(runTask).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('"state":"off"');
  });

  it('applies a disable command from the backend to settings', async () => {
    const runTask = vi.fn(async () => {});
    let enabled = true;
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false, workerEnabled: false },
      '/queue/next': { taskId: 7, taskText: 'should not run' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask, getWorkerEnabled: async () => enabled, saveWorkerEnabled: async (v) => { enabled = v; } }))).toBe('off (disabled in settings)');
    expect(enabled).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('applies an enable command from the backend and resumes claiming', async () => {
    const runTask = vi.fn(async () => {});
    let enabled = false;
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false, workerEnabled: true },
      '/queue/next': { taskId: 7, taskText: 'run me' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask, getWorkerEnabled: async () => enabled, saveWorkerEnabled: async (v) => { enabled = v; } }))).toBe('started');
    expect(enabled).toBe(true);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 7, taskText: 'run me' }), 'http://backend.test');
  });

  it('never runs two tasks concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'slow task' },
    });
    const runTask = vi.fn(async () => {
      await gate;
    });
    const workerDeps = deps({ fetchFn, runTask });
    const first = maybeRunRemoteWork(workerDeps);
    expect(await maybeRunRemoteWork(workerDeps)).toBe('busy');
    release();
    expect(await first).toBe('started');
    expect(runTask).toHaveBeenCalledOnce();
  });

  it('reboots a zombie runner whose task went terminal while busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = vi.fn();
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'hung task' },
      '/tasks': [{ id: 7, status: 'stopped' }],
    });
    const runTask = vi.fn(async () => {
      await gate;
    });
    const workerDeps = deps({ fetchFn, runTask, reload });
    const first = maybeRunRemoteWork(workerDeps);
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());
    expect(await maybeRunRemoteWork(workerDeps)).toContain('zombie runner');
    expect(reload).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('keeps heartbeating while the busy task is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reload = vi.fn();
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 7, taskText: 'healthy task' },
      '/tasks': [{ id: 7, status: 'running' }],
    });
    const runTask = vi.fn(async () => {
      await gate;
    });
    const workerDeps = deps({ fetchFn, runTask, reload });
    const first = maybeRunRemoteWork(workerDeps);
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());
    expect(await maybeRunRemoteWork(workerDeps)).toBe('busy');
    expect(reload).not.toHaveBeenCalled();
    release();
    await first;
  });
});
