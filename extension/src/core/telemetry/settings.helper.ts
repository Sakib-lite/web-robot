import { chromeArea, type StorageArea } from '../storage/area';

const KEY = 'backendUrl';
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3010';

export async function getBackendUrl(area: StorageArea = chromeArea()): Promise<string> {
  const value = (await area.get<string>(KEY))[KEY];
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : DEFAULT_BACKEND_URL;
}

export async function saveBackendUrl(url: string, area: StorageArea = chromeArea()) {
  await area.set({ [KEY]: url.trim().replace(/\/+$/, '') });
}

const WORKER_KEY = 'remoteWorkerEnabled';

export async function isRemoteWorkerEnabled(area: StorageArea = chromeArea()): Promise<boolean> {
  const value = (await area.get<boolean>(WORKER_KEY))[WORKER_KEY];
  return value !== false;
}

export async function saveRemoteWorkerEnabled(enabled: boolean, area: StorageArea = chromeArea()) {
  await area.set({ [WORKER_KEY]: enabled });
}
