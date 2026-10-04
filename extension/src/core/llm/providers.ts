import type { StorageArea } from '../storage/area';
import { ENV_SEED } from './seed';
import type { Effort, ProductId } from './products';

export interface LlmProvider {
  productId: ProductId;
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking?: Effort;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface StoredProductConfig extends LlmProvider {
  active: boolean;
}

export type ProductConfigInput = LlmProvider;

export interface ProductStore {
  area: StorageArea;
  list(): Promise<StoredProductConfig[]>;
  get(productId: ProductId): Promise<StoredProductConfig | null>;
  save(input: ProductConfigInput): Promise<StoredProductConfig>;
  activate(productId: ProductId): Promise<void>;
  clear(productId: ProductId): Promise<void>;
  allCustomModels(): Promise<Partial<Record<ProductId, string[]>>>;
  customModelsFor(productId: ProductId): Promise<string[]>;
  addCustomModel(productId: ProductId, model: string): Promise<string[]>;
  removeCustomModel(productId: ProductId, model: string): Promise<string[]>;
}

interface StoredShape {
  configs?: Partial<Record<ProductId, LlmProvider>>;
  active?: ProductId;
  customModels?: Partial<Record<ProductId, string[]>>;
}

const KEY = 'llmProductConfigs';
const LEGACY_KEY = 'llmProviders';

function normalizeEffort(value: string | undefined): Effort | undefined {
  if (!value) return undefined;
  if (value === 'off' || value === 'low' || value === 'high' || value === 'max') return value;
  return value === 'enabled' ? 'high' : 'off';
}

function validate(input: ProductConfigInput): LlmProvider {
  if (!input.baseUrl?.trim()) throw new Error('base url is required');
  if (!input.model?.trim()) throw new Error('model is required');
  return {
    productId: input.productId,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey?.trim() ?? '',
    model: input.model.trim(),
    ...(normalizeEffort(input.thinking) ? { thinking: normalizeEffort(input.thinking) } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  };
}

async function readShape(area: StorageArea): Promise<StoredShape> {
  const all = await area.get<StoredShape>(KEY);
  return (all[KEY] as StoredShape | undefined) ?? {};
}

export function createProductStore(area: StorageArea): ProductStore {
  async function write(shape: StoredShape) {
    await area.set({ [KEY]: shape });
  }

  const store: ProductStore = {
    area,

    async list() {
      const { configs, active } = await readShape(area);
      return Object.entries(configs ?? {}).map(([productId, config]) => ({
        ...config!,
        productId: productId as ProductId,
        active: productId === active,
      }));
    },

    async get(productId) {
      const { configs, active } = await readShape(area);
      const config = configs?.[productId];
      return config ? { ...config, productId, active: productId === active } : null;
    },

    async save(input) {
      const config = validate(input);
      const shape = await readShape(area);
      const active = shape.active ?? config.productId;
      await write({ ...shape, configs: { ...shape.configs, [config.productId]: config }, active });
      return { ...config, active: config.productId === active };
    },

    async activate(productId) {
      const shape = await readShape(area);
      if (!shape.configs?.[productId]) throw new Error(`product ${productId} is not configured`);
      await write({ ...shape, active: productId });
    },

    async clear(productId) {
      const shape = await readShape(area);
      if (!shape.configs?.[productId]) return;
      const configs = { ...shape.configs };
      delete configs[productId];
      await write({ ...shape, configs, active: shape.active === productId ? undefined : shape.active });
    },

    async allCustomModels() {
      const { customModels } = await readShape(area);
      return customModels ?? {};
    },

    async customModelsFor(productId) {
      return (await this.allCustomModels())[productId] ?? [];
    },

    async addCustomModel(productId, model) {
      const value = model.trim();
      if (!value) throw new Error('model id is required');
      const shape = await readShape(area);
      const current = shape.customModels?.[productId] ?? [];
      const next = current.includes(value) ? current : [...current, value];
      await write({ ...shape, customModels: { ...shape.customModels, [productId]: next } });
      return next;
    },

    async removeCustomModel(productId, model) {
      const shape = await readShape(area);
      const current = shape.customModels?.[productId] ?? [];
      const next = current.filter((m) => m !== model);
      await write({ ...shape, customModels: { ...shape.customModels, [productId]: next } });
      return next;
    },
  };
  return store;
}

export async function seedFromEnv(store: ProductStore, envSeed: LlmProvider | null = ENV_SEED) {
  await store.area.set({ [LEGACY_KEY]: null });
  if (!envSeed) return;
  const existing = await store.get('glm');
  if (existing) return;
  await store.save(envSeed);
}

export async function resolveActiveProvider(
  store: ProductStore,
  envSeed: LlmProvider | null = ENV_SEED,
  backend?: { url: string; fetchFn?: typeof fetch },
): Promise<LlmProvider | null> {
  await seedFromEnv(store, envSeed);
  if (backend) {
    const remote = await fetchActiveProviderFromBackend(backend.url, backend.fetchFn).catch(() => null);
    if (remote) {
      void store
        .save(remote)
        .then(() => store.activate(remote.productId))
        .catch(() => undefined);
      return remote;
    }
  }
  const configs = await store.list();
  return configs.find((c) => c.active) ?? null;
}

export async function fetchActiveProviderFromBackend(backendUrl: string, fetchFn: typeof fetch = fetch): Promise<LlmProvider | null> {
  const res = await fetchFn(`${backendUrl}/providers/active`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const row = (await res.json()) as { product?: string; apiKey?: string | null; baseUrl?: string | null; model?: string | null; effort?: string | null };
  if (!row.product || !row.baseUrl || !row.model) return null;
  const effort = normalizeEffort(row.effort ?? undefined);
  return {
    productId: row.product as ProductId,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey ?? '',
    model: row.model,
    ...(effort ? { thinking: effort } : {}),
  };
}

export async function syncConfigToBackend(
  backendUrl: string,
  input: ProductConfigInput & { activate?: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const { activate, ...config } = input;
  const res = await fetchFn(`${backendUrl}/providers/${config.productId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model, effort: config.thinking }),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`provider sync failed: HTTP ${res.status}`);
  if (activate) {
    const res2 = await fetchFn(`${backendUrl}/providers/${config.productId}/activate`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (!res2.ok) throw new Error(`provider activate failed: HTTP ${res2.status}`);
  }
}
