import type { LlmProvider } from './providers';

export type ModelSlot = 'main' | 'fast' | 'vision';

export const DEFAULT_SLOT_MODELS: Record<ModelSlot, string> = {
  main: 'glm-4.7',
  fast: 'glm-4.7-flash',
  vision: 'glm-4.5v',
};

// callers speak in slot names (glm-4.7, glm-4.5v, …); under a foreign provider
// those refill with the provider's own model, anything else passes through
export function effectiveModel(requested: string | undefined, provider: LlmProvider | null): string | undefined {
  const model = requested || provider?.model;
  if (!provider || !model) return model;
  if (/^glm-[a-z0-9.]*v$/i.test(model) && provider.visionModel) return provider.visionModel;
  if (/^glm[-_.]/i.test(model)) return provider.model;
  return model;
}
