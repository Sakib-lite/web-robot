import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpPlane } from '../httpPlane';
import { PlaneError } from '../plane.types';

afterEach(() => vi.unstubAllGlobals());

function fakeBackend(handler: (path: string, body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://backend.test', '');
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const reply = handler(path, body);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchFn);
  const plane = createHttpPlane(async () => 'http://backend.test');
  return { plane, calls, fetchFn };
}

describe('createHttpPlane', () => {
  it('posts each op to its endpoint with the right body', async () => {
    const { plane, calls } = fakeBackend(() => ({ status: 200, body: {} }));
    await plane.list('sub');
    await plane.read('a.md', 3, 20);
    await plane.write('a.md', 'hello', true);
    await plane.edit('a.md', 'old', 'new', true);
    await plane.append('a.md', 'more');
    await plane.delete('a.md');
    await plane.mkdir('d');
    await plane.exec('ls', 5000);

    expect(calls.map((c) => c.path)).toEqual([
      '/fs/list',
      '/fs/read',
      '/fs/write',
      '/fs/edit',
      '/fs/append',
      '/fs/delete',
      '/fs/mkdir',
      '/exec',
    ]);
    expect(calls[0]!.body).toEqual({ path: 'sub' });
    expect(calls[1]!.body).toEqual({ path: 'a.md', offset: 3, limit: 20 });
    expect(calls[2]!.body).toEqual({ path: 'a.md', content: 'hello', onlyIfNew: true });
    expect(calls[3]!.body).toEqual({ path: 'a.md', oldString: 'old', newString: 'new', replaceAll: true });
    expect(calls[7]!.body).toEqual({ cmd: 'ls', timeoutMs: 5000 });
  });

  it('describe hits GET /workspace/status and returns the info', async () => {
    const { plane } = fakeBackend(() => ({ status: 200, body: { enabled: true, root: '/Users/x/robots' } }));
    await expect(plane.describe()).resolves.toEqual({ enabled: true, root: '/Users/x/robots' });
  });

  it('surfaces the server error message and machine code as a PlaneError', async () => {
    const { plane } = fakeBackend((path) =>
      path === '/fs/write'
        ? { status: 409, body: { code: 'EXISTS', message: '"a.md" already exists (3 lines)' } }
        : { status: 200, body: {} },
    );
    const error = await plane.write('a.md', 'clobber', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlaneError);
    expect((error as PlaneError).message).toContain('already exists');
    expect((error as PlaneError).code).toBe('EXISTS');
  });

  it('falls back to a plain message when the body is not json', async () => {
    const fetchFn = vi.fn(async () => new Response('gateway died', { status: 502 }));
    vi.stubGlobal('fetch', fetchFn);
    const plane = createHttpPlane(async () => 'http://backend.test');
    const error = await plane.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlaneError);
    expect((error as PlaneError).message).toContain('HTTP 502');
  });
});
