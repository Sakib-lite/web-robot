import { effectiveModel } from './modelSlots';
import type { LlmProvider } from './providers';

export type ProductId = 'glm' | 'openai' | 'generic' | 'ollama';
export type Effort = 'off' | 'low' | 'high' | 'max';

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
}

export interface LlmProduct {
  id: ProductId;
  label: string;
  defaults: { baseUrl: string; model: string };
  models?: string[];
  efforts?: Effort[];
  keyless?: boolean;
  buildPayload: (provider: LlmProvider, req: ProductBuildInput) => WirePayload;
}

const GLM_MAX_TOKENS = 32768;
const FOREIGN_MAX_TOKENS = 16384;

function resolveModel(provider: LlmProvider, requested: string | undefined): string {
  return effectiveModel(requested, provider) ?? provider.model;
}

function glmEffortWire(provider: LlmProvider): Pick<WirePayload, 'thinking' | 'reasoning_effort'> {
  switch (provider.thinking ?? 'off') {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
    case 'high':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
    case 'max':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
  }
}

export const glmProduct: LlmProduct = {
  id: 'glm',
  label: 'GLM (Z.ai / BigModel)',
  defaults: { baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3' },
  models: [
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'glm-5.1-highspeed',
    'glm-5',
    'glm-5-turbo',
    'glm-4.7',
    'glm-4.7-flashx',
    'glm-4.7-flash',
    'glm-4.6',
    'glm-4.5-air',
    'glm-4.5',
  ],
  efforts: ['off', 'low', 'high', 'max'],
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: req.maxTokens ?? GLM_MAX_TOKENS,
    ...glmEffortWire(provider),
  }),
};

export const openaiProduct: LlmProduct = {
  id: 'openai',
  label: 'OpenAI',
  defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini', 'gpt-4.1-mini', 'gpt-4.1'],
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: Math.min(req.maxTokens ?? FOREIGN_MAX_TOKENS, FOREIGN_MAX_TOKENS),
    ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
  }),
};

export const ollamaProduct: LlmProduct = {
  id: 'ollama',
  label: 'Ollama (local)',
  defaults: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-oss:20b' },
  models: ['gpt-oss:20b', 'gpt-oss:120b'],
  efforts: ['off', 'low', 'high'],
  keyless: true,
  buildPayload: (provider, req) => ({
    model: resolveModel(provider, req.model),
    messages: req.messages,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    max_tokens: Math.min(req.maxTokens ?? FOREIGN_MAX_TOKENS, FOREIGN_MAX_TOKENS),
    ...(provider.thinking && provider.thinking !== 'off' ? { reasoning_effort: provider.thinking } : {}),
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
  ollama: ollamaProduct,
};

export function getProduct(id: ProductId): LlmProduct {
  return PRODUCTS[id];
}

export function allProducts(): LlmProduct[] {
  return Object.values(PRODUCTS);
}

export function catalogModels(product: LlmProduct, custom: readonly unknown[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const entries = [...(product.models ?? [product.defaults.model]), ...custom].flat(2) as unknown[];
  for (const model of entries) {
    if (typeof model !== 'string' && typeof model !== 'number') continue;
    const key = String(model).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
