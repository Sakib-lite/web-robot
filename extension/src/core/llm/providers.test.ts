import { describe, expect, it } from 'vitest';
import { memoryArea } from '../storage/area';
import { createProviderStore, resolveActiveProvider, type LlmProviderInput } from './providers';

function zaiProvider(over: Partial<LlmProviderInput> = {}): LlmProviderInput {
  return { name: 'Z.ai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-1', model: 'glm-4.7', ...over };
}

describe('provider store', () => {
  it('starts empty', async () => {
    const store = createProviderStore(memoryArea());
    expect(await store.list()).toEqual([]);
    expect(await resolveActiveProvider(store)).toBeNull();
  });

  it('auto-activates the first saved provider', async () => {
    const store = createProviderStore(memoryArea());
    const first = await store.save(zaiProvider());
    expect(first.active).toBe(true);
    expect((await resolveActiveProvider(store))?.id).toBe(first.id);
  });

  it('keeps exactly one active provider on activate', async () => {
    const store = createProviderStore(memoryArea());
    const a = await store.save(zaiProvider());
    const b = await store.save(zaiProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/', model: 'gpt-4o' }));
    await store.activate(b.id);
    const providers = await store.list();
    expect(providers.find((p) => p.id === a.id)?.active).toBe(false);
    expect(providers.find((p) => p.id === b.id)?.active).toBe(true);
  });

  it('normalizes trailing slashes and whitespace on save', async () => {
    const store = createProviderStore(memoryArea());
    const saved = await store.save(zaiProvider({ baseUrl: '  https://openrouter.ai/api/v1/  ', name: ' x ' }));
    expect(saved.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(saved.name).toBe('x');
  });

  it('rejects saves missing required fields', async () => {
    const store = createProviderStore(memoryArea());
    await expect(store.save(zaiProvider({ baseUrl: '' }))).rejects.toThrow('base url');
    await expect(store.save(zaiProvider({ model: '' }))).rejects.toThrow('model');
  });

  it('updates an existing provider in place and keeps its active flag', async () => {
    const store = createProviderStore(memoryArea());
    const a = await store.save(zaiProvider());
    await store.save(zaiProvider({ id: a.id, name: 'Z.ai v2', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.7', apiKey: 'sk-1' }));
    const providers = await store.list();
    expect(providers).toHaveLength(1);
    expect(providers[0]!.name).toBe('Z.ai v2');
    expect(providers[0]!.active).toBe(true);
  });

  it('hands activation to the first remaining provider after removing the active one', async () => {
    const store = createProviderStore(memoryArea());
    const a = await store.save(zaiProvider());
    const b = await store.save(zaiProvider({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-4o' }));
    await store.activate(b.id);
    await store.remove(b.id);
    const providers = await store.list();
    expect(providers).toHaveLength(1);
    expect(providers.find((p) => p.id === a.id)?.active).toBe(true);
  });

  it('throws when activating or removing an unknown id', async () => {
    const store = createProviderStore(memoryArea());
    await store.save(zaiProvider());
    await expect(store.activate('nope')).rejects.toThrow('unknown provider');
    await expect(store.remove('nope')).rejects.toThrow('unknown provider');
  });
});
