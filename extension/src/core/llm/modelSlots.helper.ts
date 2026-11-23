import type { LlmProvider } from './providers';

export function effectiveModel(requested: string | undefined, provider: LlmProvider): string | undefined {
  if (!requested) return provider.model;
  if (/^glm[-_.]/i.test(requested) && provider.productId !== 'glm') return provider.model;
  return requested;
}
