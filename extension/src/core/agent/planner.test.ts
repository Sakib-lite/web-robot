import { describe, expect, it, vi } from 'vitest';
import { planTask } from './planner';
import type { Action, Driver } from '../driver/types';
import type { ToolDef } from '../llm/chatClient';
import type { ChatMessage, ChatResponse, ToolCall } from '../llm/chatClient';

type PlannerChat = (messages: ChatMessage[], tools: ToolDef[]) => Promise<ChatResponse>;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c${Math.random().toString(36).slice(2, 6)}`, name, args };
}

function reply(content: string, calls: ToolCall[] = []): ChatResponse {
  return { content, toolCalls: calls };
}

function fakeDriver(over: Partial<Driver> = {}): Driver {
  const current = { url: 'https://shop.dev', title: 'Shop', text: 'welcome', elements: [{ ref: 'e1', tag: 'a', kind: 'link' as const, name: 'rows' }], elementsTruncated: true, elementStart: 0, elementTotal: 150 };
  const acts: string[] = [];
  return {
    tabs: async () => [{ id: 1, url: current.url, title: current.title, active: true }],
    snapshot: async (skip?: number) => ({ ...current, elementStart: skip ?? 0 }),
    act: async (action: Action) => {
      acts.push(action.type);
      if (action.type === 'goto') current.url = action.url;
      return { ok: true, detail: `${action.type} ok` };
    },
    ...(over as object),
  } as unknown as Driver;
}

function plannerChat(mock: ReturnType<typeof vi.fn>): PlannerChat {
  return mock as unknown as PlannerChat;
}

describe('planTask', () => {
  it('inspects then returns the proposed milestone plan', async () => {
    const chat = vi.fn<PlannerChat>()
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://phd.com/app' })]))
      .mockResolvedValueOnce(reply('', [toolCall('snapshot', { skip: 80 })]))
      .mockResolvedValueOnce(reply('', [toolCall('propose_plan', { items: [{ text: 'list all 48 universities in unis.md' }, { step: 'collect admission details per uni' }] })]));
    const steps: string[] = [];
    const plan = await planTask('collect 48 universities', { driver: fakeDriver(), chat: plannerChat(chat) }, (s) => steps.push(s.call));

    expect(plan).toEqual(['list all 48 universities in unis.md', 'collect admission details per uni']);
    expect(steps[0]).toContain('goto');
    expect(steps[1]).toContain('snapshot');
    expect(chat.mock.calls[1]![1].some((t) => t.name === 'propose_plan')).toBe(true);
  });

  it('is read-only: mutating tools are skipped and the loop continues', async () => {
    const chat = vi.fn<PlannerChat>()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('propose_plan', { items: ['only milestone'] })]));
    const acts: string[] = [];
    const driver = fakeDriver({
      act: (async (action: Action) => {
        acts.push(action.type);
        return { ok: true, detail: 'did' };
      }) as Driver['act'],
    });
    const plan = await planTask('do a thing', { driver, chat: plannerChat(chat) });
    expect(plan).toEqual(['only milestone']);
    expect(acts).toEqual([]);
  });

  it('falls back to an editable draft plan when the forced propose_plan yields nothing', async () => {
    const chat = vi.fn<PlannerChat>(async () => reply('', [toolCall('extract', { goal: 'read the list' })]));
    const plan = await planTask('collect all universities', { driver: fakeDriver(), chat: plannerChat(chat) }, undefined, 3);
    expect(plan).toHaveLength(3);
    expect(plan[2]).toContain('Verify completeness');
    const forced = chat.mock.calls[chat.mock.calls.length - 1]!;
    expect(forced[1].map((t) => t.name)).toEqual(['propose_plan']);
  });

  it('parses a plan the model wrote as plain JSON content instead of a tool call', async () => {
    const chat = vi.fn<PlannerChat>(async () =>
      reply('{"items":[{"text":"list all 48 universities in unis.md"},{"step":"click each row and append admission details"}]}'),
    );
    const plan = await planTask('collect universities', { driver: fakeDriver(), chat: plannerChat(chat) });
    expect(plan).toEqual(['list all 48 universities in unis.md', 'click each row and append admission details']);
  });

  it('strips leading numbering from content-written plan items', async () => {
    const chat = vi.fn<PlannerChat>(async () =>
      reply('{"items":["1. Open phd.com/app and verify 48 rows","2. Collect details per uni","3. Write the md deliverable"]}'),
    );
    const plan = await planTask('collect universities', { driver: fakeDriver(), chat: plannerChat(chat) });
    expect(plan).toEqual(['Open phd.com/app and verify 48 rows', 'Collect details per uni', 'Write the md deliverable']);
  });

  it('gives up on inspection early when observations stop changing', async () => {
    let calls = 0;
    const chat = vi.fn<PlannerChat>(async () => {
      calls++;
      return reply('', [toolCall('snapshot', {})]);
    });
    const plan = await planTask('do a thing', { driver: fakeDriver(), chat: plannerChat(chat) });
    expect(plan).toHaveLength(3);
    expect(calls).toBeLessThanOrEqual(5);
  });
});
