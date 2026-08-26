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
    fetchFn: jsonResponder({}),
    reload: vi.fn(),
    getBackend: async () => 'http://backend.test',
    runTask: vi.fn(async () => {}),
    ...over,
  };
}

describe('maybeRunRemoteWork', () => {
  it('stays idle when the backend is unreachable', async () => {
    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await maybeRunRemoteWork(deps({ fetchFn }))).toBe('idle');
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
      '/queue/next': { taskId: 'abc', taskText: 'list repos' },
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask }))).toBe('started');
    expect(runTask).toHaveBeenCalledWith('abc', 'list repos', 'http://backend.test');
  });

  it('ignores an empty queue', async () => {
    const runTask = vi.fn(async () => {});
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': {},
    });
    expect(await maybeRunRemoteWork(deps({ fetchFn, runTask }))).toBe('idle');
    expect(runTask).not.toHaveBeenCalled();
  });

  it('never runs two tasks concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchFn = jsonResponder({
      '/control/reload': { reload: false },
      '/queue/next': { taskId: 'abc', taskText: 'slow task' },
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
});
