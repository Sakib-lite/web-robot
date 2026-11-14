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
