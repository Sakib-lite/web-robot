import { describe, expect, it } from 'vitest';
import type { LlmProvider } from './providers';
import { DEFAULT_SLOT_MODELS, effectiveModel } from './modelSlots';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { id: 'p1', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk', model: 'gpt-4o', active: true, ...over };
}

describe('effectiveModel', () => {
  it('passes slot names through when no provider is set', () => {
    expect(effectiveModel(DEFAULT_SLOT_MODELS.main, null)).toBe('glm-4.7');
    expect(effectiveModel(undefined, null)).toBeUndefined();
  });

  it('falls back to the provider model when nothing was requested', () => {
    expect(effectiveModel(undefined, provider())).toBe('gpt-4o');
  });

  it('refills glm slot names with the foreign provider model', () => {
    expect(effectiveModel('glm-4.7', provider())).toBe('gpt-4o');
    expect(effectiveModel('glm-4.7-flash', provider())).toBe('gpt-4o');
  });

  it('maps the vision slot onto the provider vision model', () => {
    expect(effectiveModel('glm-4.5v', provider({ visionModel: 'gpt-4o-mini' }))).toBe('gpt-4o-mini');
    expect(effectiveModel('glm-4.5v', provider())).toBe('gpt-4o');
  });

  it('passes non-glm model names through untouched', () => {
    expect(effectiveModel('claude-sonnet-4', provider())).toBe('claude-sonnet-4');
  });

  it('keeps glm models on glm providers', () => {
    const zai = provider({ name: 'Z.ai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.7' });
    expect(effectiveModel('glm-4.7-flash', zai)).toBe('glm-4.7');
    expect(effectiveModel('glm-4.5v', zai)).toBe('glm-4.7');
    expect(effectiveModel('glm-4.5v', { ...zai, visionModel: 'glm-4.5v' })).toBe('glm-4.5v');
  });
});
