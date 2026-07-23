import { effectiveModel } from './modelSlots';
import { isGlmRequest } from './glm';
import type { LlmProvider } from './providers';

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  model?: string;
  maxTokens?: number;
  thinking?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

const DEFAULT_MAX_TOKENS = 32768;
const FOREIGN_MAX_TOKENS = 16384;

export function buildPayload(provider: LlmProvider, req: ChatRequest) {
  const model = effectiveModel(req.model, provider) ?? provider.model;
  const glm = isGlmRequest(provider.baseUrl, model);
  const want = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    model,
    messages: req.messages.map(toWireMessage),
    ...(req.tools?.length ? { tools: req.tools.map(toWireTool) } : {}),
    max_tokens: glm ? want : Math.min(want, FOREIGN_MAX_TOKENS),
    ...(glm ? { thinking: { type: req.thinking ? 'enabled' : 'disabled' } } : {}),
  };
}

function toWireTool(tool: ToolDef) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function toWireMessage(message: ChatMessage) {
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      ...(message.content ? { content: message.content } : { content: null }),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
  }
  return { role: message.role, content: message.content ?? '' };
}

interface WireChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseToolCall(call: { id?: string; function?: { name?: string; arguments?: string } }): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function?.arguments ?? '{}');
  } catch {
    args = { _raw: call.function?.arguments ?? '' };
  }
  return { id: call.id ?? '', name: call.function?.name ?? '', args };
}

export async function chatCompletion(
  provider: LlmProvider,
  req: ChatRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ChatResponse> {
  const endpoint = `${provider.baseUrl}/chat/completions`;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(buildPayload(provider, req)),
    signal: req.signal,
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`llm request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  let parsed: WireResponse;
  try {
    parsed = JSON.parse(body) as WireResponse;
  } catch {
    throw new Error(`llm returned invalid json: ${body.slice(0, 200)}`);
  }

  const choice = parsed.choices?.[0]?.message;
  return {
    content: choice?.content ?? '',
    toolCalls: choice?.tool_calls?.map(parseToolCall) ?? [],
    ...(parsed.usage ? { usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } } : {}),
  };
}
