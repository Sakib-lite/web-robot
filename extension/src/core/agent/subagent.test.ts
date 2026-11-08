import { describe, expect, it, vi } from 'vitest';
import { makeSubAgent } from './subagent';
import type { Driver } from '../driver/types';
import type { ChatResponse, ToolCall } from '../llm/chatClient';
import { toolDefs } from './tools';

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c${Math.random().toString(36).slice(2, 6)}`, name, args };
}

function reply(content: string, calls: ToolCall[] = []): ChatResponse {
  return { content, toolCalls: calls };
}

function fakeDriver(): Driver {
  return {
    tabs: async () => [],
    snapshot: async () => {
      throw new Error('no page');
    },
    act: async () => ({ ok: true, detail: 'ok' }),
  };
}

describe('makeSubAgent', () => {
  it('runs the child to done and returns a labeled digest', async () => {
    const chat = vi.fn().mockResolvedValueOnce(
      reply('', [toolCall('done', { summary: 'found\nRust — Graydon Hoare — rust-lang.org' })]),
    );
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat });
    const digest = await spawn('who created Rust');
    expect(digest).toContain('sub-agent 1');
    expect(digest).toContain('who created Rust');
    expect(digest).toContain('done');
    expect(digest).toContain('Graydon Hoare');

    const system = (chat.mock.calls[0]![0] as Array<{ role: string; content: string }>)[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('ONE item');
  });

  it('gives the child the research toolset and a fresh driver per spawn', async () => {
    const chat = vi.fn().mockResolvedValue(reply('', [toolCall('done', { summary: 'x' })]));
    const drivers = [fakeDriver(), fakeDriver(), fakeDriver()];
    let made = 0;
    const spawn = makeSubAgent({ makeDriver: () => drivers[made++]!, chat });
    await spawn('item a');
    await spawn('item b');
    expect(made).toBe(2);

    const tools = chat.mock.calls[0]![1] as ReturnType<typeof toolDefs>;
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('ask_user');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('sub_agent');
    expect(names).toContain('new_tab');
    expect(names).toContain('extract');
  });

  it('labels failed and stopped children as scoped losses', async () => {
    const chat = vi.fn().mockResolvedValueOnce(reply('', [toolCall('fail', { reason: 'login wall' })]));
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat });
    const digest = await spawn('blocked item');
    expect(digest).toContain('sub-agent 1');
    expect(digest).toContain('failed');
    expect(digest).toContain('login wall');
  });

  it('numbers sub-agents sequentially and truncates long digests', async () => {
    const long = 'x'.repeat(3000);
    const chat = vi.fn().mockResolvedValue(reply('', [toolCall('done', { summary: long })]));
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat });
    const first = await spawn('item one');
    const second = await spawn('item two');
    expect(first).toContain('sub-agent 1');
    expect(second).toContain('sub-agent 2');
    expect(second.length).toBeLessThanOrEqual(1502);
  });

  it('forwards child steps with a sub-agent prefix', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://rust-lang.org' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    const onStep = vi.fn();
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat, onStep });
    await spawn('item');
    expect(onStep).toHaveBeenCalled();
    expect(onStep.mock.calls[0]![0].call).toBe('[s1] goto https://rust-lang.org');
  });

  it('persists every digest to subagents.md when a workspace is provided', async () => {
    const chat = vi.fn().mockResolvedValue(reply('', [toolCall('done', { summary: 'found: X — url' })]));
    const appended: string[] = [];
    const plane = {
      append: async (path: string, text: string) => {
        appended.push(`${path}\n${text}`);
        return { bytes: text.length, totalBytes: text.length };
      },
    };
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat, workspace: { plane: plane as never, taskId: 42 } });
    await spawn('item one');
    await spawn('item two');
    expect(appended).toHaveLength(2);
    expect(appended[0]).toContain('.web-robot/tasks/42/subagents.md');
    expect(appended[0]).toContain('## sub-agent 1 — item one');
    expect(appended[1]).toContain('## sub-agent 2 — item two');
    expect(appended[0]).toContain('found: X');
  });

  it('keeps working when the digest write fails', async () => {
    const chat = vi.fn().mockResolvedValue(reply('', [toolCall('done', { summary: 'ok' })]));
    const plane = {
      append: async () => {
        throw new Error('plane down');
      },
    };
    const spawn = makeSubAgent({ makeDriver: fakeDriver, chat, workspace: { plane: plane as never, taskId: 7 } });
    const digest = await spawn('item');
    expect(digest).toContain('sub-agent 1');
    expect(digest).toContain('done');
  });
});
