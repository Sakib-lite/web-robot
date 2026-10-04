import { getProduct } from './products';
import type { ToolDef, ToolCall, ChatMessage, ChatRequest, ChatResponse } from './types';

export type { ToolDef, ToolCall, ChatMessage, ChatRequest, ChatResponse };

const DEFAULT_MAX_TOKENS = 32768;

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
  provider: import('./providers').LlmProvider,
  req: ChatRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ChatResponse> {
  const product = getProduct(provider.productId);
  const payload = product.buildPayload(provider, {
    messages: req.messages.map(toWireMessage),
    ...(req.tools?.length ? { tools: req.tools.map(toWireTool) } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.maxTokens ? { maxTokens: req.maxTokens } : { maxTokens: DEFAULT_MAX_TOKENS }),
    ...(req.thinking !== undefined ? { thinking: req.thinking } : {}),
  });

  let res!: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetchFn(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
    if (res.ok || res.status < 500 || res.status > 504 || attempt >= 3 || req.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }

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
    ...(parsed.usage
      ? { usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } }
      : {}),
  };
}
