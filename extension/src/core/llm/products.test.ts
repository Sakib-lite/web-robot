import { describe, expect, it } from 'vitest';
import { allProducts, getProduct } from './products';
import type { LlmProvider } from './providers';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk', model: 'glm-5.3', ...over };
}

describe('product registry', () => {
  it('has one strategy per product id', () => {
    expect(allProducts().map((p) => p.id)).toEqual(['glm', 'openai', 'generic', 'ollama']);
    expect(getProduct('openai').label).toBe('OpenAI');
  });
});

describe('glm strategy', () => {
  it('maps effort levels onto thinking + reasoning_effort wire params', () => {
    expect(getProduct('glm').buildPayload(provider({ thinking: 'off' }), { messages: [] }).thinking).toEqual({ type: 'disabled' });
    const low = getProduct('glm').buildPayload(provider({ thinking: 'low' }), { messages: [] });
    expect(low.thinking).toEqual({ type: 'enabled' });
    expect(low.reasoning_effort).toBe('low');
    const max = getProduct('glm').buildPayload(provider({ thinking: 'max' }), { messages: [] });
    expect(max.thinking).toEqual({ type: 'enabled' });
    expect(max.reasoning_effort).toBe('max');
  });

  it('sends the full token budget for glm', () => {
    const payload = getProduct('glm').buildPayload(provider(), { messages: [], maxTokens: 8000 });
    expect(payload.max_tokens).toBe(8000);
    expect(getProduct('glm').buildPayload(provider(), { messages: [] }).max_tokens).toBe(32768);
  });

  it('normalizes legacy enabled/disabled values through the store', async () => {
    const { createProductStore } = await import('./providers');
    const { memoryArea } = await import('../storage/area');
    const store = createProductStore(memoryArea());
    await store.save({ productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk', model: 'glm-5.3', thinking: 'disabled' as never });
    expect((await store.get('glm'))?.thinking).toBe('off');
  });

  it('omits tools when none are given', () => {
    const payload = getProduct('glm').buildPayload(provider(), { messages: [] });
    expect('tools' in payload).toBe(false);
  });
});

describe('openai strategy', () => {
  it('clamps the token budget and passes reasoning effort through', () => {
    const payload = getProduct('openai').buildPayload(
      provider({ productId: 'openai', model: 'o4-mini', reasoningEffort: 'high' }),
      { messages: [], maxTokens: 32768 },
    );
    expect(payload).toMatchObject({ model: 'o4-mini', max_tokens: 16384, reasoning_effort: 'high' });
    expect('thinking' in payload).toBe(false);
  });

  it('omits reasoning effort when unset', () => {
    const payload = getProduct('openai').buildPayload(provider({ productId: 'openai' }), { messages: [] });
    expect('reasoning_effort' in payload).toBe(false);
  });
});

describe('generic strategy', () => {
  it('keeps the request plain and refills glm slot models with its own', () => {
    const payload = getProduct('generic').buildPayload(
      provider({ productId: 'generic', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-4o' }),
      { messages: [], model: 'glm-4.7', maxTokens: 32768 },
    );
    expect(payload).toMatchObject({ model: 'gpt-4o', max_tokens: 16384 });
    expect('thinking' in payload).toBe(false);
    expect('reasoning_effort' in payload).toBe(false);
  });
});

describe('db-backed provider resolution', () => {
  function backendResponder(row: unknown, status = 200): typeof fetch {
    return (async () => new Response(JSON.stringify(row), { status })) as unknown as typeof fetch;
  }

  it('prefers the backend db row and mirrors it into the store cache', async () => {
    const { createProductStore, resolveActiveProvider } = await import('./providers');
    const { memoryArea } = await import('../storage/area');
    const store = createProductStore(memoryArea());
    await store.save({ productId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'gpt-oss:20b' });
    await store.activate('ollama');

    const fetchFn = backendResponder({ product: 'glm', apiKey: 'dbkey', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'GLM-5.3-Flash', effort: 'low' });
    const resolved = await resolveActiveProvider(store, null, { url: 'http://backend.test', fetchFn });
    expect(resolved).toMatchObject({ productId: 'glm', apiKey: 'dbkey', model: 'GLM-5.3-Flash', thinking: 'low' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.get('glm')).toMatchObject({ apiKey: 'dbkey', model: 'GLM-5.3-Flash' });
    expect((await store.get('glm'))?.active).toBe(true);
  });

  it('falls back to the chrome.storage cache when the backend is unreachable', async () => {
    const { createProductStore, resolveActiveProvider } = await import('./providers');
    const { memoryArea } = await import('../storage/area');
    const store = createProductStore(memoryArea());
    await store.save({ productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'local', model: 'glm-5.3' });
    await store.activate('glm');
    const fetchFn = (async () => { throw new Error('backend down'); }) as unknown as typeof fetch;
    const resolved = await resolveActiveProvider(store, null, { url: 'http://backend.test', fetchFn });
    expect(resolved).toMatchObject({ productId: 'glm', apiKey: 'local' });
  });

  it('syncs a config to the backend db on save/activate', async () => {
    const { syncConfigToBackend } = await import('./providers');
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await syncConfigToBackend(
      'http://backend.test',
      { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk', model: 'glm-5.3', thinking: 'high', activate: true },
      fetchFn,
    );
    expect(calls[0]).toMatchObject({ url: 'http://backend.test/providers/glm', method: 'PUT' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ apiKey: 'sk', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3', effort: 'high' });
    expect(calls[1]).toMatchObject({ url: 'http://backend.test/providers/glm/activate', method: 'POST' });
  });
});
