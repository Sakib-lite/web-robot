import { effectiveModel } from './modelSlots';
import type { LlmProvider } from './providers';

export type ProductId = 'glm' | 'openai' | 'generic';

export interface WirePayload {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  max_tokens: number;
  thinking?: { type: string };
  reasoning_effort?: string;
}

export interface ProductBuildInput {
  messages: unknown[];
  tools?: unknown[];
  model?: string;
  maxTokens?: number;
  thinking?: boolean;
}

export interface LlmProduct {
  id: ProductId;
  label: string;
  defaults: { baseUrl: string; model: string };
  buildPayload: (provider: LlmProvider, req: ProductBuildInput) => WirePayload;
}

const GLM_MAX_TOKENS = 32768;
const FOREIGN_MAX_TOKENS = 16384;

function resolveModel(provider: LlmProvider, requested: string | undefined): string {
  return effectiveModel(requested, provider) ?? provider.model;
}

export const glmProduct: LlmProduct = {
  id: 'glm',
  label: 'GLM (Z.ai / BigModel)',
  defaults: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3' },
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: req.maxTokens ?? GLM_MAX_TOKENS,
    thinking: { type: (req.thinking ?? provider.thinking === 'enabled') ? 'enabled' : 'disabled' },
  }),
};

export const openaiProduct: LlmProduct = {
  id: 'openai',
  label: 'OpenAI',
  defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: Math.min(req.maxTokens ?? FOREIGN_MAX_TOKENS, FOREIGN_MAX_TOKENS),
    ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
  }),
};

export const genericProduct: LlmProduct = {
  id: 'generic',
  label: 'Other (OpenAI-compatible)',
  defaults: { baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-4o-mini' },
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: Math.min(req.maxTokens ?? FOREIGN_MAX_TOKENS, FOREIGN_MAX_TOKENS),
  }),
};

const PRODUCTS: Record<ProductId, LlmProduct> = {
  glm: glmProduct,
  openai: openaiProduct,
  generic: genericProduct,
};

export function getProduct(id: ProductId): LlmProduct {
  return PRODUCTS[id];
}

export function allProducts(): LlmProduct[] {
  return Object.values(PRODUCTS);
}
