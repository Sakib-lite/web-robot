import { PlaneError, type ExecResult, type FileSlice, type LocalPlane, type WorkspaceInfo } from './plane';

const FS_TIMEOUT_MS = 15_000;

export function createHttpPlane(getBackendUrl: () => Promise<string>): LocalPlane {
  const call = async (path: string, body: Record<string, unknown>, timeoutMs = FS_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const base = await getBackendUrl();
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PlaneError(
        typeof data.message === 'string' ? data.message : `${path} → HTTP ${res.status}`,
        typeof data.code === 'string' ? data.code : undefined,
      );
    }
    return data;
  };

  return {
    describe: async (): Promise<WorkspaceInfo> => {
      const base = await getBackendUrl();
      const res = await fetch(`${base}/workspace/status`, { signal: AbortSignal.timeout(FS_TIMEOUT_MS) });
      if (!res.ok) throw new PlaneError(`workspace status → HTTP ${res.status}`);
      return (await res.json()) as WorkspaceInfo;
    },
    list: async (path) => (await call('/fs/list', { path: path ?? '.' })) as never,
    read: async (path, offset, limit): Promise<FileSlice> =>
      (await call('/fs/read', { path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) })) as never,
    write: async (path, content, onlyIfNew, encoding) =>
      (await call('/fs/write', { path, content, ...(onlyIfNew ? { onlyIfNew: true } : {}), ...(encoding ? { encoding } : {}) })) as never,
    edit: async (path, oldString, newString, replaceAll) =>
      (await call('/fs/edit', { path, oldString, newString, ...(replaceAll ? { replaceAll: true } : {}) })) as never,
    append: async (path, text) => (await call('/fs/append', { path, text })) as never,
    delete: async (path) => (await call('/fs/delete', { path })) as never,
    mkdir: async (path) => (await call('/fs/mkdir', { path })) as never,
    exec: async (cmd, timeoutMs, cwd): Promise<ExecResult> =>
      (await call('/exec', { cmd, ...(timeoutMs ? { timeoutMs } : {}), ...(cwd ? { cwd } : {}) }, (timeoutMs ?? 120_000) + 15_000)) as never,
  };
}
