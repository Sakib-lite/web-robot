import { describe, expect, it } from 'vitest';
import { memoryArea } from '../storage/area';
import {
  createProductStore,
  resolveActiveProvider,
  seedFromEnv,
  type LlmProvider,
  type ProductConfigInput,
} from './providers';

function glmConfig(over: Partial<ProductConfigInput> = {}): ProductConfigInput {
  return { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-1', model: 'glm-5.3', thinking: 'off', ...over };
}

function openaiConfig(over: Partial<ProductConfigInput> = {}): ProductConfigInput {
  return { productId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oai', model: 'gpt-4o-mini', ...over };
}

describe('product store', () => {
  it('starts with no configured products', async () => {
    const store = createProductStore(memoryArea());
    expect(await store.list()).toEqual([]);
    expect(await store.get('glm')).toBeNull();
  });

  it('saves per-product configs and auto-activates the first', async () => {
    const store = createProductStore(memoryArea());
    const saved = await store.save(glmConfig());
    expect(saved.active).toBe(true);
    expect((await store.get('openai'))).toBeNull();
    expect((await resolveActiveProvider(store))?.productId).toBe('glm');
  });

  it('keeps one active product across saves and activations', async () => {
    const area = memoryArea();
    const store = createProductStore(area);
    await store.save(glmConfig());
    await store.save(openaiConfig());
    await store.activate('openai');
    const configs = await store.list();
    expect(configs.find((c) => c.productId === 'glm')?.active).toBe(false);
    expect(configs.find((c) => c.productId === 'openai')?.active).toBe(true);
    const resolved = await resolveActiveProvider(store);
    expect(resolved?.productId).toBe('openai');
    expect(resolved?.model).toBe('gpt-4o-mini');
  });

  it('carries the product knobs (thinking, reasoning effort) through save', async () => {
    const store = createProductStore(memoryArea());
    await store.save(glmConfig({ thinking: 'max' }));
    await store.save(openaiConfig({ reasoningEffort: 'medium' }));
    expect((await store.get('glm'))?.thinking).toBe('max');
    expect((await store.get('openai'))?.reasoningEffort).toBe('medium');
  });

  it('normalizes base urls and rejects empty models', async () => {
    const store = createProductStore(memoryArea());
    const saved = await store.save(glmConfig({ baseUrl: 'https://api.z.ai/api/coding/paas/v4///' }));
    expect(saved.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
    await expect(store.save(glmConfig({ model: '' }))).rejects.toThrow('model is required');
  });

  it('refuses activation of unconfigured products and clears cleanly', async () => {
    const store = createProductStore(memoryArea());
    await expect(store.activate('generic')).rejects.toThrow('not configured');
    await store.save(glmConfig());
    await store.clear('glm');
    expect(await store.get('glm')).toBeNull();
    expect(await resolveActiveProvider(store, null)).toBeNull();
  });

  it('seeds the glm config from env once and keeps user edits afterwards', async () => {
    const store = createProductStore(memoryArea());
    const envSeed: LlmProvider = { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-env', model: 'glm-5.3', thinking: 'off' };

    await seedFromEnv(store, envSeed);
    expect((await store.get('glm'))?.apiKey).toBe('sk-env');

    await store.save(glmConfig({ apiKey: 'sk-user' }));
    await seedFromEnv(store, envSeed);
    expect((await store.get('glm'))?.apiKey).toBe('sk-user');
  });

  it('wipes the legacy provider table during seeding', async () => {
    const area = memoryArea();
    await area.set({ llmProviders: [{ id: 'old', name: 'BigModel' }] });
    const store = createProductStore(area);
    await seedFromEnv(store, null);
    expect((await area.get('llmProviders'))['llmProviders']).toBeNull();
  });
});
