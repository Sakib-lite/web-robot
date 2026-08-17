import { describe, expect, it, vi } from 'vitest';
import { isDangerous, runTask, type LoopDeps, type StepRecord } from './loop';
import type { Action, Driver, Snapshot, TabInfo } from '../driver/types';
import type { ChatResponse, ToolCall } from '../llm/chatClient';

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c${Math.random().toString(36).slice(2, 6)}`, name, args };
}

function reply(content: string, calls: ToolCall[] = []): ChatResponse {
  return { content, toolCalls: calls };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { url: 'https://shop.dev', title: 'Shop', text: 'welcome', elements: [], ...over };
}

function fakeDriver(over: Partial<Driver> = {}): Driver {
  const tabs: TabInfo[] = [{ id: 1, url: 'https://shop.dev', title: 'Shop', active: true }];
  let current = snapshot();
  const actions: Action[] = [];
  return {
    tabs: async () => tabs,
    snapshot: async () => current,
    act: async (action) => {
      actions.push(action);
      if (action.type === 'goto') current = snapshot({ url: action.url, title: action.url });
      return { ok: true, detail: 'done' };
    },
    ...over,
  };
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    driver: fakeDriver(),
    chat: async () => reply('ok'),
    askUser: async () => 'yes',
    ...over,
  };
}

describe('isDangerous', () => {
  const snap = snapshot({ elements: [{ ref: 'e1', tag: 'button', kind: 'button', name: 'Place order' }, { ref: 'e2', tag: 'button', kind: 'button', name: 'Details' }] });

  it('flags submit-like clicks and ignores safe ones', () => {
    expect(isDangerous({ type: 'click', ref: 'e1' }, snap)).toBe('click "Place order"');
    expect(isDangerous({ type: 'click', ref: 'e2' }, snap)).toBeNull();
    expect(isDangerous({ type: 'fill', ref: 'e2', text: 'x' }, snap)).toBeNull();
    expect(isDangerous({ type: 'click', ref: 'e9' }, snap)).toBeNull();
  });
});

describe('runTask', () => {
  it('runs actions until done and reports the summary', async () => {
    const driver = fakeDriver();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://shop.dev/offers' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'opened offers' })]));
    const result = await runTask('open the offers page', deps({ driver, chat }));

    expect(result.status).toBe('done');
    expect(result.summary).toBe('opened offers');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.call).toBe('goto https://shop.dev/offers');
    expect(chat).toHaveBeenCalledTimes(2);

    const context = (chat.mock.calls[1]![0] as import('../llm/chatClient').ChatMessage[]).find(
      (m) => m.role === 'user' && m.content?.includes('STEPS'),
    )?.content ?? '';
    expect(context).toContain('goto https://shop.dev/offers');
  });

  it('fails when the model calls fail', async () => {
    const chat = async () => reply('', [toolCall('fail', { reason: 'login wall' })]);
    const result = await runTask('do the thing', deps({ chat }));
    expect(result).toMatchObject({ status: 'failed', reason: 'login wall' });
  });

  it('nudges once when the model replies with plain text, then fails on the second time', async () => {
    const chat = vi.fn().mockResolvedValue(reply('I will just explain...'));
    const result = await runTask('do the thing', deps({ chat }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('model stopped calling tools');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('asks the user and feeds the answer back into the loop', async () => {
    const askUser = vi.fn().mockResolvedValue('use gmail');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('ask_user', { question: 'which email provider?' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    await runTask('send an email', deps({ chat, askUser }));

    expect(askUser).toHaveBeenCalledWith('which email provider?');
    const secondContext = (chat.mock.calls[1]![0] as import('../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(secondContext).toContain('use gmail');
  });

  it('stops when the user dismisses a question', async () => {
    const askUser = vi.fn().mockResolvedValue(null);
    const chat = async () => reply('', [toolCall('ask_user', { question: 'creds?' })]);
    const result = await runTask('log in', deps({ chat, askUser }));
    expect(result.status).toBe('stopped');
  });

  it('requires confirmation for dangerous clicks and skips them when declined', async () => {
    const snap = snapshot({ elements: [{ ref: 'e1', tag: 'button', kind: 'button', name: 'Place order' }] });
    const driver = fakeDriver({
      snapshot: async () => snap,
      act: async () => {
        throw new Error('should not be called');
      },
    });
    const askUser = vi.fn().mockResolvedValue('no');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'stopped before ordering' })]));
    const result = await runTask('buy the thing', deps({ driver, chat, askUser }));

    expect(askUser).toHaveBeenCalledOnce();
    expect(result.status).toBe('done');
    expect(result.steps[0]!.ok).toBe(false);
    expect(result.steps[0]!.detail).toContain('user declined');
  });

  it('fails after the step limit', async () => {
    let counter = 0;
    const chat = async () => reply('', [toolCall('scroll', { direction: 'down', amount: 300 })]);
    const driver = fakeDriver({
      snapshot: async () => snapshot({ elements: Array.from({ length: counter + 1 }, (_, i) => ({ ref: `e${i}`, tag: 'div', kind: 'other' as const, name: `row ${i}` })) }),
      act: async () => {
        counter++;
        return { ok: true, detail: `scroll #${counter}` };
      },
    });
    const result = await runTask('scroll forever', deps({ driver, chat, maxSteps: 5 }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('step limit of 5');
    expect(result.steps).toHaveLength(5);
  });

  it('fails on loop detection when the same action repeats on an unchanged page', async () => {
    const chat = async () => reply('', [toolCall('click', { ref: 'e1' })]);
    const driver = fakeDriver({ act: async () => ({ ok: true, detail: 'clicked' }) });
    const result = await runTask('click it', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('loop detected');
  });

  it('detects url ping-pong with swapped query parameter order', async () => {
    const urls = ['https://x.dev/repo?tab=repositories&page=2', 'https://x.dev/repo?page=2&tab=repositories'];
    let i = 0;
    const chat = async () => reply('', [toolCall('goto', { url: urls[i++ % urls.length] })]);
    const driver = fakeDriver({ act: async (action) => ({ ok: true, detail: `went ${(action as { url: string }).url}` }) });
    const result = await runTask('list page 2', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('loop detected');
  });

  it('accumulates extract results into the model context', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('extract', { goal: 'repo names' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'collected' })]));
    const driver = fakeDriver({
      act: async (action) => (action.type === 'extract' ? { ok: true, detail: 'web-robot\nresume-server\nstopwatch' } : { ok: true, detail: 'ok' }),
    });
    const result = await runTask('list repos', deps({ driver, chat }));

    expect(result.status).toBe('done');
    expect(result.steps[0]!.detail).toBe('33 chars extracted');
    const context = (chat.mock.calls[1]![0] as import('../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(context).toContain('EXTRACTED CONTENT:');
    expect(context).toContain('web-robot\nresume-server\nstopwatch');
  });

  it('records invalid tool arguments as a failed step and continues', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', {})]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'recovered' })]));
    const result = await runTask('click', deps({ chat }));
    expect(result.status).toBe('done');
    expect(result.steps[0]!.ok).toBe(false);
    expect(result.steps[0]!.detail).toContain('invalid arguments');
  });

  it('surfaces llm errors as a failed task', async () => {
    const chat = async () => {
      throw new Error('llm request failed (401)');
    };
    const result = await runTask('anything', deps({ chat }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('llm error');
  });

  it('streams steps through onStep', async () => {
    const onStep = vi.fn();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('press', { key: 'Enter' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'done' })]));
    await runTask('press enter', deps({ chat, onStep }));
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ index: 1, call: 'press Enter', ok: true, detail: 'done' }));
  });

  it('stops immediately when the signal is already aborted', async () => {
    const chat = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const result = await runTask('anything', deps({ chat, signal: controller.signal }));
    expect(result.status).toBe('stopped');
    expect(chat).not.toHaveBeenCalled();
  });

  it('streams observation, llm, action and answer events to telemetry', async () => {
    const observe = vi.fn(async (_step: number, _data: Record<string, unknown>) => {});
    const llm = vi.fn(async (_step: number, _data: Record<string, unknown>) => {});
    const action = vi.fn(async (_step: number, _data: Record<string, unknown>) => {});
    const answer = vi.fn(async (_step: number, _data: Record<string, unknown>) => {});
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('ask_user', { question: 'which site?' })]))
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://chosen.dev' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    const result = await runTask('go somewhere', deps({ chat, telemetry: { observe, llm, action, answer } }));

    expect(result.status).toBe('done');
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe.mock.calls[0]![0]).toBe(1);
    expect(answer).toHaveBeenCalledWith(1, expect.objectContaining({ question: 'which site?', answer: 'yes' }));
    expect(action).toHaveBeenCalledWith(2, expect.objectContaining({ tool: 'goto', ok: true }));
    const llmData = llm.mock.calls[0]![1] as Record<string, unknown>;
    expect(llmData.toolCalls).toBeDefined();
    expect(typeof llmData.durationMs).toBe('number');
  });

  it('records llm errors into telemetry before failing', async () => {
    const llm = vi.fn(async (_step: number, _data: Record<string, unknown>) => {});
    const chat = async () => {
      throw new Error('boom');
    };
    await runTask('t', deps({ chat, telemetry: { observe: async () => {}, llm, action: async () => {}, answer: async () => {} } }));
    expect(llm).toHaveBeenCalledWith(1, expect.objectContaining({ error: 'boom' }));
  });
});

describe('StepRecord shape', () => {
  it('numbers steps from one', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('scroll', { direction: 'up' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    const result = await runTask('t', deps({ chat }));
    const indexes = result.steps.map((s: StepRecord) => s.index);
    expect(indexes).toEqual([1]);
  });
});
