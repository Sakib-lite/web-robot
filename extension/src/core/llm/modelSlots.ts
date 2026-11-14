import type { LlmProvider } from './providers';

// callers may speak in glm slot names; under a foreign product those refill
// with that product's own configured model, anything else passes through
export function effectiveModel(requested: string | undefined, provider: LlmProvider): string | undefined {
  if (!requested) return provider.model;
  if (/^glm[-_.]/i.test(requested) && provider.productId !== 'glm') return provider.model;
  return requested;
}
