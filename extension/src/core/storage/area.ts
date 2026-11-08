export interface StorageArea {
  get<T = unknown>(keys: string | string[] | null): Promise<Record<string, T>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function memoryArea(): StorageArea {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const wanted = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out as Record<string, never>;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
}

export function chromeArea(): StorageArea {
  return chrome.storage.local;
}
