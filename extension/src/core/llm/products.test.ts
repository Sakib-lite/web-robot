import { describe, expect, it } from 'vitest';
import { allProducts, getProduct } from './products';
import type { LlmProvider } from './providers';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk', model: 'glm-5.3', ...over };
}

describe('product registry', () => {
  it('has one strategy per product id', () => {
    expect(allProducts().map((p) => p.id)).toEqual(['glm', 'openai', 'generic']);
    expect(getProduct('openai').label).toBe('OpenAI');
  });
});

describe('glm strategy', () => {
  it('sends thinking state and the full token budget', () => {
    const payload = getProduct('glm').buildPayload(provider({ thinking: 'enabled' }), { messages: [], maxTokens: 8000 });
    expect(payload).toMatchObject({ model: 'glm-5.3', max_tokens: 8000, thinking: { type: 'enabled' } });
  });

  it('defaults thinking to disabled', () => {
    const payload = getProduct('glm').buildPayload(provider(), { messages: [] });
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.max_tokens).toBe(32768);
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
