import { describe, expect, it } from 'vitest';
import { chatCompletion } from '../chatClient';
import type { LlmProvider } from '../providers';
import type { ToolDef } from '../types';

function provider(over: Partial<LlmProvider> = {}): LlmProvider {
  return { productId: 'glm', baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-test', model: 'glm-5.3', ...over };
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

describe('chatCompletion wire behavior per product', () => {
  it('sends glm thinking and full budget, parses tool calls back', async () => {
    let captured: RequestInit | undefined;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return jsonResponse(200, okBody());
    };
    const res = await chatCompletion(provider({ thinking: 'max' }), { messages: [{ role: 'user', content: 'hi' }], tools: [tool], maxTokens: 8000 }, fetchFn);

    const payload = JSON.parse(String(captured!.body));
    expect(payload).toMatchObject({ model: 'glm-5.3', max_tokens: 8000, thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    expect(payload.tools[0].function.name).toBe('click');
    expect(res.content).toBe('ok');
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'click', args: { ref: 'e3' } }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(new Headers(captured!.headers).get('authorization')).toBe('Bearer sk-test');
  });

  it('switches wire shape with the product: openai gets clamped tokens, no thinking', async () => {
    let captured: RequestInit | undefined;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return jsonResponse(200, okBody());
    };
    await chatCompletion(provider({ productId: 'openai', model: 'gpt-4o' }), { messages: [] }, fetchFn);
    const payload = JSON.parse(String(captured!.body));
    expect(payload.model).toBe('gpt-4o');
    expect(payload.max_tokens).toBe(16384);
    expect('thinking' in payload).toBe(false);
  });

  it('serializes assistant tool calls and tool results for the follow-up turn', async () => {
    let captured: RequestInit | undefined;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return jsonResponse(200, okBody());
    };
    await chatCompletion(
      provider(),
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', toolCalls: [{ id: 'c1', name: 'click', args: { ref: 'e3' } }] },
          { role: 'tool', toolCallId: 'c1', content: 'clicked' },
        ],
      },
      fetchFn,
    );
    const payload = JSON.parse(String(captured!.body));
    expect(payload.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'click', arguments: '{"ref":"e3"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'clicked' },
    ]);
  });

  it('tolerates malformed tool arguments', async () => {
    const body = { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'click', arguments: '{broken' } }] } }] };
    const res = await chatCompletion(provider(), { messages: [] }, async () => jsonResponse(200, body));
    expect(res.toolCalls[0]!.args).toEqual({ _raw: '{broken' });
  });

  it('throws a descriptive error on non-2xx responses', async () => {
    const call = chatCompletion(provider(), { messages: [] }, async () => jsonResponse(401, { error: 'bad key' }));
    await expect(call).rejects.toThrow('llm request failed (401)');
  });

  it('captures model thinking from reasoning_content and reasoning fields', async () => {
    const glmBody = { choices: [{ message: { content: 'ok', reasoning_content: 'step one: consider the page', tool_calls: [] } }] };
    const res = await chatCompletion(provider(), { messages: [] }, async () => jsonResponse(200, glmBody));
    expect(res.thinking).toBe('step one: consider the page');

    const ollamaBody = { choices: [{ message: { content: 'ok', reasoning: 'ollama style thinking' } }] };
    const res2 = await chatCompletion(provider({ productId: 'generic' }), { messages: [] }, async () => jsonResponse(200, ollamaBody));
    expect(res2.thinking).toBe('ollama style thinking');
  });

  it('throws on invalid json bodies', async () => {
    const call = chatCompletion(provider(), { messages: [] }, async () => new Response('not json', { status: 200 }));
    await expect(call).rejects.toThrow('invalid json');
  });

  it('retries transient 5xx responses and succeeds', async () => {
    let calls = 0;
    const res = await chatCompletion(provider(), { messages: [] }, async () => {
      calls++;
      return calls === 1 ? jsonResponse(500, { error: 'error parsing tool call' }) : jsonResponse(200, okBody());
    });
    expect(calls).toBe(2);
    expect(res.content).toBe('ok');
  });

  it('gives up after three attempts on persistent 5xx', async () => {
    let calls = 0;
    const call = chatCompletion(provider(), { messages: [] }, async () => {
      calls++;
      return jsonResponse(502, { error: 'down' });
    });
    await expect(call).rejects.toThrow('llm request failed (502)');
    expect(calls).toBe(3);
  });

  it('does not retry client errors', async () => {
    let calls = 0;
    const call = chatCompletion(provider(), { messages: [] }, async () => {
      calls++;
      return jsonResponse(403, { error: 'forbidden' });
    });
    await expect(call).rejects.toThrow('llm request failed (403)');
    expect(calls).toBe(1);
  });
});
