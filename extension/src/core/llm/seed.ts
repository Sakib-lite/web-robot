import type { LlmProvider } from './providers';

const env = import.meta.env as Record<string, string | undefined>;
const apiKey = env.VITE_WEB_ROBOT_LLM_API_KEY?.trim();
const baseUrl = env.VITE_WEB_ROBOT_LLM_BASE_URL?.trim().replace(/\/+$/, '');
const model = env.VITE_WEB_ROBOT_LLM_MODEL?.trim();

export const ENV_SEED: LlmProvider | null =
  apiKey && baseUrl && model
    ? {
        productId: 'glm',
        baseUrl,
        apiKey,
        model,
        thinking: 'off',
      }
    : null;
