import { describe, expect, it } from 'vitest';
import { effectiveModel } from './modelSlots';
import type { LlmProvider } from './providers';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { productId: 'generic', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk', model: 'gpt-4o', ...over };
}

describe('effectiveModel', () => {
  it('falls back to the product model when nothing was requested', () => {
    expect(effectiveModel(undefined, provider())).toBe('gpt-4o');
    expect(effectiveModel('', provider())).toBe('gpt-4o');
  });

  it('refills glm slot names with the foreign product model', () => {
    expect(effectiveModel('glm-4.7', provider())).toBe('gpt-4o');
    expect(effectiveModel('glm-4.7-flash', provider({ productId: 'openai' }))).toBe('gpt-4o');
  });

  it('keeps glm model names on the glm product', () => {
    expect(effectiveModel('glm-4.7', provider({ productId: 'glm', model: 'glm-5.3' }))).toBe('glm-4.7');
  });

  it('passes non-glm names through untouched', () => {
    expect(effectiveModel('claude-sonnet-4', provider())).toBe('claude-sonnet-4');
    expect(effectiveModel('o4-mini', provider({ productId: 'openai' }))).toBe('o4-mini');
  });
});
