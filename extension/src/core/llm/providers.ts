import type { StorageArea } from '../storage/area';
import { ENV_SEED } from './seed';
import type { ProductId } from './products';

export interface LlmProvider {
  productId: ProductId;
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking?: 'enabled' | 'disabled';
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
}

interface StoredShape {
  configs?: Partial<Record<ProductId, LlmProvider>>;
  active?: ProductId;
}

const KEY = 'llmProductConfigs';
const LEGACY_KEY = 'llmProviders';

function validate(input: ProductConfigInput): LlmProvider {
  if (!input.baseUrl?.trim()) throw new Error('base url is required');
  if (!input.model?.trim()) throw new Error('model is required');
  return {
    productId: input.productId,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey?.trim() ?? '',
    model: input.model.trim(),
    ...(input.thinking ? { thinking: input.thinking } : {}),
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
      await write({ configs, active: shape.active === productId ? undefined : shape.active });
    },
  };
  return store;
}

export async function seedFromEnv(store: ProductStore, envSeed: LlmProvider | null = ENV_SEED) {
  await store.area.set({ [LEGACY_KEY]: undefined });
  if (!envSeed) return;
  const existing = await store.get('glm');
  if (existing) return;
  await store.save(envSeed);
}

export async function resolveActiveProvider(store: ProductStore, envSeed: LlmProvider | null = ENV_SEED): Promise<LlmProvider | null> {
  await seedFromEnv(store, envSeed);
  const configs = await store.list();
  return configs.find((c) => c.active) ?? null;
}
