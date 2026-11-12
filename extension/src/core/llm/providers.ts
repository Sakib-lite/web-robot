import type { StorageArea } from '../storage/area';
import { HARDCODED_PROVIDER } from './seed';

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  active: boolean;
}

export type LlmProviderInput = Omit<LlmProvider, 'id' | 'active'> & { id?: string };

export interface ProviderStore {
  list(): Promise<LlmProvider[]>;
  save(input: LlmProviderInput): Promise<LlmProvider>;
  activate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const KEY = 'llmProviders';

function newId() {
  return `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalize(input: LlmProviderInput): LlmProvider {
  if (!input.name?.trim()) throw new Error('provider name is required');
  if (!input.baseUrl?.trim()) throw new Error('provider base url is required');
  if (!input.model?.trim()) throw new Error('provider model is required');
  return {
    id: input.id ?? newId(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey?.trim() ?? '',
    model: input.model.trim(),
    ...(input.visionModel?.trim() ? { visionModel: input.visionModel.trim() } : {}),
    active: false,
  };
}

export function createProviderStore(area: StorageArea): ProviderStore {
  async function read(): Promise<LlmProvider[]> {
    const rows = (await area.get<LlmProvider[]>(KEY))[KEY];
    return Array.isArray(rows) ? rows : [];
  }

  async function write(providers: LlmProvider[]) {
    await area.set({ [KEY]: providers });
  }

  return {
    async list() {
      return read();
    },

    async save(input) {
      const provider = normalize(input);
      const providers = await read();
      const existingIndex = input.id ? providers.findIndex((p) => p.id === input.id) : -1;
      if (existingIndex >= 0) {
        provider.active = providers[existingIndex]!.active;
        providers[existingIndex] = provider;
      } else {
        provider.active = providers.length === 0;
        providers.push(provider);
      }
      await write(providers);
      return provider;
    },

    async activate(id) {
      const providers = await read();
      if (!providers.some((p) => p.id === id)) throw new Error(`unknown provider: ${id}`);
      await write(providers.map((p) => ({ ...p, active: p.id === id })));
    },

    async remove(id) {
      const providers = await read();
      const remaining = providers.filter((p) => p.id !== id);
      if (remaining.length === providers.length) throw new Error(`unknown provider: ${id}`);
      if (providers.find((p) => p.id === id)?.active && remaining.length > 0 && !remaining.some((p) => p.active)) {
        remaining[0] = { ...remaining[0]!, active: true };
      }
      await write(remaining);
    },
  };
}

export async function resolveActiveProvider(store: ProviderStore): Promise<LlmProvider | null> {
  const providers = await store.list();
  return providers.find((p) => p.active) ?? HARDCODED_PROVIDER;
}
