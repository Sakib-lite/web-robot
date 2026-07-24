import { describe, expect, it } from 'vitest';
import { buildPayload, chatCompletion, type ChatMessage, type ToolDef } from './chatClient';
import type { LlmProvider } from './providers';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { id: 'p1', name: 'test', baseUrl: 'https://api.test/v4', apiKey: 'sk-test', model: 'gpt-4o', active: true, ...over };
}

const tool: ToolDef = {
  name: 'click',
  description: 'click an element',
  parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
};

function okBody(over: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'click', arguments: '{"ref":"e3"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('buildPayload', () => {
  it('adds thinking and full max_tokens on glm endpoints', () => {
    const payload = buildPayload(provider({ baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.7' }), { messages: [{ role: 'user', content: 'hi' }], thinking: false, maxTokens: 8000 });
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.max_tokens).toBe(8000);
  });

  it('clamps max_tokens and omits thinking on foreign endpoints', () => {
    const payload = buildPayload(provider(), { messages: [{ role: 'user', content: 'hi' }], maxTokens: 32768 });
    expect('thinking' in payload).toBe(false);
    expect(payload.max_tokens).toBe(16384);
  });

  it('serializes assistant tool calls and tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'click', args: { ref: 'e3' } }] },
      { role: 'tool', toolCallId: 'c1', content: 'clicked' },
    ];
    const payload = buildPayload(provider(), { messages });
    expect(payload.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"ref":"e3"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'clicked' },
    ]);
  });

  it('maps tools onto the function wire shape', () => {
    const payload = buildPayload(provider(), { messages: [], tools: [tool] });
    expect(payload.tools).toEqual([{ type: 'function', function: { name: 'click', description: 'click an element', parameters: tool.parameters } }]);
  });
});

describe('chatCompletion', () => {
  it('posts to the provider endpoint with bearer auth', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse(200, okBody());
    };
    const res = await chatCompletion(provider(), { messages: [{ role: 'user', content: 'hi' }] }, fetchFn);
    expect(captured!.url).toBe('https://api.test/v4/chat/completions');
    expect(new Headers(captured!.init.headers).get('authorization')).toBe('Bearer sk-test');
    expect(res.content).toBe('ok');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'click', args: { ref: 'e3' } }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('tolerates malformed tool arguments', async () => {
    const body = { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'click', arguments: '{broken' } }] } }] };
    const res = await chatCompletion(provider(), { messages: [] }, async () => jsonResponse(200, body));
    expect(res.toolCalls[0]!.args).toEqual({ _raw: '{broken' });
  });

  it('returns empty tool calls when the model replies with plain text', async () => {
    const body = { choices: [{ message: { content: 'just saying hi' } }] };
    const res = await chatCompletion(provider(), { messages: [] }, async () => jsonResponse(200, body));
    expect(res.content).toBe('just saying hi');
    expect(res.toolCalls).toEqual([]);
  });

  it('throws a descriptive error on non-2xx responses', async () => {
    const call = chatCompletion(provider(), { messages: [] }, async () => jsonResponse(401, { error: 'bad key' }));
    await expect(call).rejects.toThrow('llm request failed (401)');
  });

  it('throws on invalid json bodies', async () => {
    const call = chatCompletion(provider(), { messages: [] }, async () => new Response('not json', { status: 200 }));
    await expect(call).rejects.toThrow('invalid json');
  });
});
