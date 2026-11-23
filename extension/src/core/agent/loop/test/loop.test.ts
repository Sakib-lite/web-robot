import { describe, expect, it, vi } from 'vitest';
import { runTask, type LoopDeps, type StepRecord } from '../loop';
import { isDangerous } from '../guards.helper';
import type { Action, Driver, Snapshot, TabInfo } from '../../../driver/types';
import type { ChatMessage, ChatResponse, ToolCall } from '../../../llm/chatClient';
import { PlaneError } from '../../../local/plane.types';

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
  const snap = snapshot({ elements: [
    { ref: 'e1', tag: 'button', kind: 'button', name: 'Place order' },
    { ref: 'e2', tag: 'button', kind: 'button', name: 'Details' },
    { ref: 'e3', tag: 'button', kind: 'button', name: 'Multiple Ph.D. student or postdoc positions Drexel University' },
    { ref: 'e4', tag: 'button', kind: 'button', name: 'Submit application' },
    { ref: 'e5', tag: 'button', kind: 'button', name: 'Postdoc openings in order of deadline' },
  ] });

  it('flags submit-like clicks, ignores safe ones and postdoc-titled rows', () => {
    expect(isDangerous({ type: 'click', ref: 'e1' }, snap)).toBe('click "Place order"');
    expect(isDangerous({ type: 'click', ref: 'e2' }, snap)).toBeNull();
    expect(isDangerous({ type: 'click', ref: 'e3' }, snap)).toBeNull();
    expect(isDangerous({ type: 'click', ref: 'e4' }, snap)).toContain('Submit application');
    expect(isDangerous({ type: 'click', ref: 'e5' }, snap)).toBeNull();
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
    expect(result.summary).toContain('opened offers');
    expect(result.summary).toContain('distinct page states,');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.call).toBe('goto https://shop.dev/offers');
    expect(chat).toHaveBeenCalledTimes(2);

    const context = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).find(
      (m) => m.role === 'user' && m.content?.includes('STEPS'),
    )?.content ?? '';
    expect(context).toContain('goto https://shop.dev/offers');
  });

  it('attaches model thinking to the step that executes its call', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[]) => ({ content: '', thinking: 'I should click the first row', toolCalls: [toolCall('goto', { url: 'https://x.dev' })] }));
    const result = await runTask('go', deps({ chat }));
    expect(result.steps[0]!.thinking).toBe('I should click the first row');
  });

  it('fails when the model calls fail', async () => {
    const chat = async () => reply('', [toolCall('fail', { reason: 'login wall' })]);
    const result = await runTask('do the thing', deps({ chat }));
    expect(result).toMatchObject({ status: 'failed', reason: 'login wall' });
  });

  it('nudges on non-tool replies and fails on the third', async () => {
    const chat = vi.fn().mockResolvedValue(reply('I will just explain...'));
    const result = await runTask('do the thing', deps({ chat }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('model stopped calling tools');
    expect(chat).toHaveBeenCalledTimes(3);

    const empty = vi.fn().mockResolvedValue(reply(''));
    const emptyResult = await runTask('do the thing', deps({ chat: empty }));
    expect(emptyResult.reason).toContain('empty replies');
  });

  it('asks the user and feeds the answer back into the loop', async () => {
    const askUser = vi.fn().mockResolvedValue('use gmail');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('ask_user', { question: 'which email provider?' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    await runTask('send an email', deps({ chat, askUser }));

    expect(askUser).toHaveBeenCalledWith('which email provider?', undefined);
    const secondContext = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(secondContext).toContain('use gmail');
  });

  it('auto-applies the recommended answer when the user never replies', async () => {
    const askUser = vi.fn(async () => null);
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('done', { summary: 'done with the default' })]));
    vi.mocked(chat)
      .mockImplementationOnce(async () => reply('', [toolCall('ask_user', { question: 'which site?', recommended: 'use phd.com/app' })]));
    const result = await runTask('do the thing', deps({ chat: chat as never, askUser }));
    expect(result.status).toBe('done');
    const q = (chat.mock.calls[1]![0] as ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(q).toContain('auto-applied after 30s');
    expect(q).toContain('use phd.com/app');
  });

  it('stops when the user dismisses a question', async () => {
    const askUser = vi.fn().mockResolvedValue(null);
    const chat = async () => reply('', [toolCall('ask_user', { question: 'creds?' })]);
    const result = await runTask('log in', deps({ chat, askUser }));
    expect(result.status).toBe('stopped');
  });

  it('delegates to a sub-agent and feeds the digest back as context', async () => {
    const subAgent = vi.fn().mockResolvedValue('sub-agent 1 ("find rust creator") done:\nRust — Graydon Hoare — rust-lang.org');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('sub_agent', { task: 'find rust creator', budget: 10 })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'collected' })]));
    const result = await runTask('research languages', deps({ chat, subAgent }));

    expect(subAgent).toHaveBeenCalledExactlyOnceWith('find rust creator', 10);
    expect(result.status).toBe('done');
    expect(result.steps[0]!.call).toBe('sub_agent #1');
    expect(result.steps[0]!.ok).toBe(true);

    const context = (chat.mock.calls[1]![0] as ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(context).toContain('sub-agent 1: find rust creator');
    expect(context).toContain('Graydon Hoare');
  });

  it('records a scoped loss when the sub-agent crashes or is unwired', async () => {
    const subAgent = vi.fn().mockRejectedValue(new Error('driver exploded'));
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('sub_agent', { task: 'item a' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'moved on' })]));
    const crashed = await runTask('t', deps({ chat, subAgent }));
    expect(crashed.steps[0]!.ok).toBe(true);
    expect((chat.mock.calls[1]![0] as ChatMessage[]).map((m) => m.content ?? '').join('\n')).toContain('crashed');

    const unwired = vi.fn().mockResolvedValueOnce(reply('', [toolCall('sub_agent', { task: 'item b' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'fine' })]));
    const bare = await runTask('t', deps({ chat: unwired as never }));
    expect(bare.status).toBe('done');
    expect(bare.steps[0]!.ok).toBe(false);
    expect(bare.steps[0]!.detail).toContain('unavailable');
  });

  it('blocks spawns past the cap and pushes the model to finish', async () => {
    const subAgent = vi.fn().mockResolvedValue('sub-agent done: ok');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('sub_agent', { task: 'item a' })]))
      .mockResolvedValueOnce(reply('', [toolCall('sub_agent', { task: 'item b' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'wrapped up' })]));
    const result = await runTask('many items', deps({ chat, subAgent, maxSubAgents: 1 }));

    expect(subAgent).toHaveBeenCalledOnce();
    expect(result.status).toBe('done');
    expect(result.steps[1]!.ok).toBe(false);
    expect(result.steps[1]!.detail).toContain('sub-agent limit of 1');
  });

  it('cancels queued sub_agent calls so the parent handles each digest first', async () => {
    const subAgent = vi.fn().mockResolvedValue('sub-agent 1 ("item a") done: fact — url');
    const batched = reply('', [
      toolCall('sub_agent', { task: 'item a' }),
      toolCall('sub_agent', { task: 'item b' }),
      toolCall('sub_agent', { task: 'item c' }),
    ]);
    const chat = vi
      .fn()
      .mockResolvedValueOnce(batched)
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'file written between spawns' })]));
    const result = await runTask('three items', deps({ chat, subAgent }));

    expect(subAgent).toHaveBeenCalledExactlyOnceWith('item a', undefined);
    expect(result.status).toBe('done');
    const secondContext = (chat.mock.calls[1]![0] as ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(secondContext).toContain('2 queued sub_agent call(s) were cancelled');
    expect(secondContext).toContain('ONE sub_agent at a time');
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

  it('forces a digest from a research child that exhausts its budget', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://group.example' })]))
      .mockResolvedValueOnce(reply('', [toolCall('extract', { goal: 'papers' })]))
      .mockResolvedValueOnce(reply('partial\nfocus on ML - "we study time series" - https://group.example'));
    const result = await runTask('research the group', deps({ chat, research: true, maxSteps: 2 }));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('time series');
    expect(result.summary).toContain('budget exhausted at 2 steps');
    expect(chat).toHaveBeenCalledTimes(3);
    const forced = chat.mock.calls[2] as unknown as [ChatMessage[], Array<{ name: string }>];
    expect(forced[1]).toHaveLength(0);
    expect(forced[0].map((m) => m.content ?? '').join('\n')).toContain('STEP BUDGET EXHAUSTED');
  });

  it('still fails the child when the forced digest comes back empty', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://group.example' })]))
      .mockResolvedValueOnce(reply(''));
    const result = await runTask('research the group', deps({ chat, research: true, maxSteps: 1 }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('step limit of 1');
  });

  it('blocks repeated no-op actions but keeps the task alive', async () => {
    const act = vi.fn(async () => ({ ok: true, detail: 'clicked' }));
    const driver = fakeDriver({ act });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'moved on after NJIT was a dead end' })]));
    const result = await runTask('list the universities', deps({ driver, chat }));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('moved on');
    expect(act).toHaveBeenCalledTimes(5);
    expect((act.mock.calls as unknown as Array<[Action]>).some(([a]) => a.type === 'click' && a.trusted === true)).toBe(true);
    const blockedSteps = result.steps.filter((s) => !s.ok && s.detail.includes('blocked'));
    expect(blockedSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('feeds the chat history as real turns on a continuation', async () => {
    const chat = vi.fn(async () => reply('', [toolCall('done', { summary: 'continued with memory' })]));
    await runTask('what else did you find?', {
      driver: fakeDriver(),
      chat,
      askUser: async () => null,
      history: [
        { role: 'user', content: 'find the unis' },
        { role: 'assistant', content: 'found 31 groups, saved shortlist.md' },
      ],
    });
    const first = (chat.mock.calls as unknown as Array<[ChatMessage[]]>)[0]![0];
    const roles = first.map((m) => m.role);
    expect(roles).toEqual(expect.arrayContaining(['system', 'user', 'assistant', 'user']));
    const joined = first.map((m) => m.content ?? '').join('\n');
    expect(joined).toContain('found 31 groups, saved shortlist.md');
    expect(joined).toContain('what else did you find?');
  });

  it('saves screenshots into the task folder as binary files', async () => {
    const writes: Array<{ path: string; content: string; encoding?: string }> = [];
    const plane = {
      write: async (path: string, content: string, _onlyIfNew?: boolean, encoding?: 'base64') => {
        writes.push({ path, content, encoding });
        return { bytes: content.length };
      },
    };
    const driver = fakeDriver({
      act: async () => ({ ok: true, detail: 'captured', data: { dataUrl: 'data:image/png;base64,QUJD', width: 800, height: 600 } }),
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('screenshot', {})]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'shot saved' })]));
    const result = await runTask('take a screenshot', {
      driver,
      chat,
      askUser: async () => null,
      taskId: 9,
      workspace: { plane: plane as never, root: '/tmp/robots' },
    });

    expect(result.status).toBe('done');
    expect(writes).toEqual([{ path: '.web-robot/tasks/9/screenshots/step-1.png', content: 'QUJD', encoding: 'base64' }]);
    expect(result.steps[0]!.detail).toContain('screenshots/step-1.png');
    expect(result.steps[0]!.detail).toContain('800x600');
  });

  it('reports a screenshot even without a workspace to save it into', async () => {
    const driver = fakeDriver({
      act: async () => ({ ok: true, detail: 'captured', data: { dataUrl: 'data:image/jpeg;base64,QQ==', width: 10, height: 10 } }),
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('screenshot', { full_page: true })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    const result = await runTask('shoot', deps({ driver, chat }));
    expect(result.status).toBe('done');
    expect(result.steps[0]!.call).toBe('screenshot (full page)');
    expect(result.steps[0]!.detail).toContain('not saved');
  });

  it('lets the agent switch targets after a blocked sub-goal', async () => {
    let state = 0;
    const driver = fakeDriver({
      act: async (action) => {
        const gotoAction = action as { url?: string };
        if (gotoAction.url?.includes('mit.edu')) state = 1;
        return { ok: true, detail: `went ${gotoAction.url ?? 'x'}` };
      },
      snapshot: async () =>
        snapshot({
          url: state === 1 ? 'https://web.mit.edu/admissions' : 'https://www.njit.edu/admissions',
          title: state === 1 ? 'MIT' : 'NJIT',
        }),
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('goto', { url: 'https://web.mit.edu/admissions' })]))
      .mockResolvedValueOnce(reply('', [toolCall('extract', { goal: 'english req' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'NJIT failed, MIT listed' })]));
    const result = await runTask('list both universities', deps({ driver, chat }));

    expect(result.status).toBe('done');
    expect(result.summary).toContain('MIT');
  });

  it('reports a no-effect interaction in context (task-97 semantics)', async () => {
    const snap = snapshot({ elements: [{ ref: 'e1', tag: 'div', kind: 'button' as const, name: 'dead row' }] });
    const driver = fakeDriver({ snapshot: async () => snap, act: async () => ({ ok: true, detail: 'clicked e1' }) });
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('click', { ref: 'e1' })]));
    const result = await runTask('click it', deps({ driver, chat }));
    expect(result.status).toBe('failed');
    const noteSeen = chat.mock.calls.some((c) => (c[0] as ChatMessage[]).some((m) => m.content?.includes('no visible effect on the page')));
    expect(noteSeen).toBe(true);
  });

  it('regression #97: a select with a value lets the model verify the filter from the observation and click rows', async () => {
    const page = snapshot({
      elements: [
        { ref: 'e23', tag: 'select', kind: 'select' as const, name: 'Filter the list by status', value: 'New', options: ['All', 'New', 'Applied', 'Automated'] },
        { ref: 'e38', tag: 'div', kind: 'button' as const, name: 'PhD Position at ISTA' },
      ],
    });
    const driver = fakeDriver({ snapshot: async () => page });
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('click', { ref: 'e38' })]));
    const result = await runTask('check the filter then click rows', deps({ driver, chat }));
    const first = (chat.mock.calls as unknown as Array<[ChatMessage[]]>)[0]![0];
    const observation = first.find((m) => m.role === 'user' && m.content?.includes('CURRENT PAGE'))?.content ?? '';
    expect(observation).toContain('value="New"');
    expect(observation).toContain('options=All|New|Applied|Automated');
    expect(result.steps.some((s) => s.ok && s.call.includes('e38'))).toBe(true);
  });

  it('blocks a fourth consecutive read and demands action', async () => {
    let calls = 0;
    const chat = vi.fn(async (_messages: ChatMessage[]) => {
      calls++;
      return reply('', [toolCall('extract', { goal: `look ${calls}` })]);
    });
    const result = await runTask('collect things', deps({ chat }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('reads blocked');
    const blockedNote = chat.mock.calls.some((c) => (c[0] as ChatMessage[]).some((m) => m.content?.includes('READS ARE BLOCKED')));
    expect(blockedNote).toBe(true);
    expect(calls).toBeLessThan(12);
  });

  it('bounces a done that skips the required web research, accepts after navigation', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('done', { summary: 'Task complete' })]));
    const driver = fakeDriver({ act: async (action: Action) => ({ ok: true, detail: `did ${action.type}` }) });
    const result = await runTask('collect unis, then web search each university admission details', deps({ driver, chat }));

    expect(result.status).toBe('done');
    const bounced = chat.mock.calls.some((c) => (c[0] as ChatMessage[]).some((m) => m.content?.includes('never left the original site')));
    expect(bounced).toBe(true);
  });

  it('accepts done without web research when the task never asked for it', async () => {
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('done', { summary: 'Task complete' })]));
    const result = await runTask('collect unis from the page', deps({ chat }));
    expect(result.status).toBe('done');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('executes every tool call in a batched response, not just the first', async () => {
    const acts: string[] = [];
    const driver = fakeDriver({ act: async (action: Action) => { acts.push(action.type); return { ok: true, detail: 'did' }; } });
    const chat = vi.fn(async (_messages: ChatMessage[]) => reply('', [toolCall('done', { summary: 'clicked all' })]));
    vi.mocked(chat)
      .mockImplementationOnce(async () => reply('', [toolCall('click', { ref: 'e1' }), toolCall('click', { ref: 'e2' }), toolCall('click', { ref: 'e3' })]))
      .mockImplementationOnce(async () => reply('', [toolCall('done', { summary: 'clicked all' })]));
    const result = await runTask('click three rows', deps({ driver, chat: chat as never }));
    expect(result.status).toBe('done');
    expect(result.summary).toContain('3 distinct elements clicked');
    expect(acts.filter((a) => a === 'click')).toHaveLength(6);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('blocks a ninth consecutive exec probe until something is recorded', async () => {
    const plane = fakePlane({ exec: async (cmd: string) => ({ code: 0, output: `ran ${cmd}`, timedOut: false, durationMs: 2 }) });
    let n = 0;
    const chat = vi.fn(async (_messages: ChatMessage[]) => {
      n++;
      return reply('', [toolCall('exec', { cmd: `probe number ${n}` })]);
    });
    const result = await runTask('probe forever', deps({ chat, workspace: { plane, root: '/tmp/robots' } }));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('exec probing');
    const noteSeen = chat.mock.calls.some((c) => (c[0] as ChatMessage[]).some((m) => m.content?.includes('Stop probing')));
    expect(noteSeen).toBe(true);
  });

  it('treats an aborted in-flight llm call as stopped, not failed', async () => {
    const controller = new AbortController();
    const chat = async () => {
      controller.abort();
      throw new Error('signal is aborted without reason');
    };
    const result = await runTask('do it', deps({ chat, signal: controller.signal }));
    expect(result.status).toBe('stopped');
    expect(result.reason).toBe('cancelled by user');
  });

  it('fails as stalled only when every chosen action is blocked', async () => {
    const urls = ['https://x.dev/repo?tab=repositories&page=2', 'https://x.dev/repo?page=2&tab=repositories'];
    let i = 0;
    const chat = async () => reply('', [toolCall('goto', { url: urls[i++ % urls.length] })]);
    const driver = fakeDriver({ act: async (action) => ({ ok: true, detail: `went ${(action as { url: string }).url}` }) });
    const result = await runTask('list page 2', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('stalled');
  });







  it('blocks navigation ping-pong across tool types (goto vs new_tab to the same url)', async () => {
    const chat = vi
      .fn()
      .mockImplementation(async () => {
        const n = chat.mock.calls.length;
        const action = n % 2 === 1
          ? toolCall('goto', { url: 'https://graduate.fsu.edu/english-proficiency' })
          : toolCall('new_tab', { url: 'https://graduate.fsu.edu/english-proficiency/' });
        return reply('', [action]);
      });
    const act = vi.fn(async (action: Action) => ({ ok: true, detail: `did ${action.type}` }));
    const driver = fakeDriver({ act });
    const result = await runTask('open the fsu page', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('stalled');
    expect(act.mock.calls.filter((c) => (c[0] as Action).type === 'goto' || (c[0] as Action).type === 'new_tab').length).toBe(4);
  });

  it('allows different extract goals on an unchanged page, blocks only identical repeats', async () => {
    const goals = ['PTE minimum', 'quote the PTE paragraph', 'find PTE score sentence', 'PTE score listed after TOEFL', 'what PTE score is required'];
    let i = 0;
    const act = vi.fn(async (action: Action) =>
      action.type === 'extract' ? { ok: true, detail: 'NO TEXT MATCHES YOUR GOAL...' } : { ok: true, detail: 'ok' });
    const driver = fakeDriver({ act });
    const chat = vi
      .fn()
      .mockImplementation(async () => {
        const goal = goals[Math.min(i++, goals.length - 1)];
        return reply('', [toolCall('extract', { goal })]);
      });
    const result = await runTask('find the pte score', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('reads blocked');
    expect(act.mock.calls.filter((c) => (c[0] as Action).type === 'extract').length).toBe(3);
  });

  it('caps total extracts on one unchanged page state', async () => {
    let i = 0;
    const act = vi.fn(async (action: Action) =>
      action.type === 'extract' ? { ok: true, detail: 'NOTHING...' } : { ok: true, detail: 'ok' });
    const driver = fakeDriver({ act });
    const chat = vi.fn(async () => {
      i++;
      return reply('', [toolCall('extract', { goal: `question number ${i}` })]);
    });
    const result = await runTask('keep asking', deps({ driver, chat }));

    expect(result.status).toBe('failed');
    const acted = act.mock.calls.filter((c) => (c[0] as Action).type === 'extract').length;
    expect(acted).toBe(3);
    const blocked = result.steps.filter((s) => !s.ok && (s.detail.includes('read 6 times') || s.detail.includes('three read-only calls'))).length;
    expect(blocked).toBeGreaterThanOrEqual(1);
  });

  it('does not count a click as a repeat when the page state actually changed', async () => {
    let expanded = false;
    const snap = () =>
      snapshot({
        elements: [{ ref: 'e1', tag: 'button', kind: 'button', name: 'English scores', expanded }],
        text: expanded ? 'scores expanded' : 'collapsed',
      });
    const driver = fakeDriver({
      snapshot: async () => snap(),
      act: async () => {
        expanded = true;
        return { ok: true, detail: 'clicked e1' };
      },
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e1' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'read the accordion' })]));
    const result = await runTask('expand and read', deps({ driver, chat }));
    expect(result.status).toBe('done');
    expect(chat).toHaveBeenCalledTimes(3);
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
    const context = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
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

  it('auto-notes extract digests into the working memory', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('extract', { goal: 'PTE score' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    const driver = fakeDriver({
      act: async (action) => (action.type === 'extract' ? { ok: true, detail: 'PTE Academic minimum 55 accepted for CS.' } : { ok: true, detail: 'ok' }),
    });
    await runTask('t', deps({ driver, chat }));
    const context = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(context).toContain('YOUR NOTES');
    expect(context).toContain('auto · PTE score → PTE Academic minimum 55 accepted');
  });

  it('nudges when a click fails on a stale ref', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('click', { ref: 'e9' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    const driver = fakeDriver({
      act: async () => ({ ok: false, detail: 'ref e9 not found on the page - take a new snapshot' }),
    });
    await runTask('t', deps({ driver, chat }));
    const secondMessages = chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[];
    expect(secondMessages.some((m) => m.role === 'system' && m.content?.includes('refs from the LATEST observation'))).toBe(true);
  });

  it('keeps note calls as durable working memory visible to later turns', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('note', { text: 'UIC: PTE 54 verified at mscs.uic.edu' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'listed' })]));
    const result = await runTask('list unis', deps({ chat }));

    expect(result.status).toBe('done');
    expect(result.steps[0]!.call).toBe('note');
    const context = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(context).toContain('YOUR NOTES');
    expect(context).toContain('UIC: PTE 54 verified at mscs.uic.edu');
  });

  it('warns the model to wrap up when the step budget runs low', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('scroll', { direction: 'down' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    let count = 0;
    const driver = fakeDriver({
      snapshot: async () => snapshot({ elements: [{ ref: `e${count}`, tag: 'div', kind: 'other' as const, name: `row ${count}` }] }),
      act: async () => {
        count++;
        return { ok: true, detail: 'ok' };
      },
    });
    await runTask('t', deps({ driver, chat, maxSteps: 16 }));

    const secondMessages = chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[];
    expect(secondMessages.some((m) => m.role === 'system' && m.content?.includes('Only 15 steps left'))).toBe(true);
  });

  it('streams steps through onStep', async () => {    const onStep = vi.fn();
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

  function fakePlane(over: Partial<import('../../../local/plane.types').LocalPlane> = {}) {
    const files = new Map<string, string>();
    const plane: import('../../../local/plane.types').LocalPlane = {
      describe: async () => ({ enabled: true, root: '/tmp/robots' }),
      webFetch: async (url) => ({ url, title: 'Fetched Page', text: `content of ${url}`, truncated: false }),
      webSearch: async (query) => ({ results: [{ title: `about ${query}`, url: 'https://result.dev/x', snippet: 'a snippet' }] }),
      list: async () => ({ entries: [{ name: 'a.md', dir: false, size: 5 }], truncated: false }),
      read: async (path, offset = 1, limit = 300) => {
        const content = files.get(path);
        if (content === undefined) throw new PlaneError(`"${path}" does not exist`, 'NOT_FOUND');
        const lines = content.split('\n');
        return { path, totalLines: lines.length, offset, lines: lines.slice(offset - 1, offset - 1 + limit).map((text, i) => ({ n: offset + i, text })) };
      },
      write: async (path, content, onlyIfNew) => {
        if (onlyIfNew && files.has(path)) throw new PlaneError(`"${path}" already exists (3 lines) - read_file it first`, 'EXISTS');
        files.set(path, content);
        return { bytes: content.length };
      },
      edit: async (path, oldString, newString) => {
        const content = files.get(path);
        if (content === undefined) throw new PlaneError(`"${path}" does not exist`, 'NOT_FOUND');
        const count = content.split(oldString).length - 1;
        if (count === 0) throw new PlaneError('old_string not found', 'NO_MATCH');
        files.set(path, content.replace(oldString, newString));
        return { line: 2, occurrences: 1 };
      },
      append: async (path, text) => {
        const next = (files.get(path) ?? '') + text;
        files.set(path, next);
        return { bytes: text.length, totalBytes: next.length };
      },
      delete: async (path) => {
        files.delete(path);
        return { path };
      },
      mkdir: async (path) => ({ path }),
      exec: async (cmd) => ({ code: 0, output: `ran: ${cmd}`, timedOut: false, durationMs: 5 }),
      ...over,
    };
    return Object.assign(plane, { files });
  }

describe('workspace tools', () => {
  function wsDeps(over: Partial<LoopDeps> & { plane?: import('../../../local/plane.types').LocalPlane } = {}): LoopDeps {
    const { plane, ...rest } = over;
    return deps({ ...rest, workspace: { plane: plane ?? fakePlane(), root: '/tmp/robots' } });
  }

  it('creates a new file blind, and redirects an overwrite of an unread file to an append', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('write_file', { path: 'out.md', content: '# head' })]))
      .mockResolvedValueOnce(reply('', [toolCall('write_file', { path: 'out.md', content: 'more content' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'written' })]));
    const result = await runTask('write it', wsDeps({ chat, plane: fakePlane() }));
    expect(result.status).toBe('done');
    expect(result.steps[1]!.ok).toBe(true);
    expect(result.steps[1]!.detail).toContain('appended instead');
  });

  it('allows editing only after a read, and the read stays in context', async () => {
    const plane = fakePlane();
    plane.files.set('report.md', '# Report\nold line\n');
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('edit_file', { path: 'report.md', old_string: 'old line', new_string: 'new line' })]))
      .mockResolvedValueOnce(reply('', [toolCall('read_file', { path: 'report.md' })]))
      .mockResolvedValueOnce(reply('', [toolCall('edit_file', { path: 'report.md', old_string: 'old line', new_string: 'new line' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'edited' })]));
    const result = await runTask('edit the report', wsDeps({ chat, plane }));

    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0]!.detail).toContain('blind edits');
    expect(result.steps[2]).toMatchObject({ ok: true, detail: 'replaced 1 occurrence(s) at line 2' });
    expect(plane.files.get('report.md')).toContain('new line');

    const thirdContext = (chat.mock.calls[2]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(thirdContext).toContain('LATEST LOCAL RESULT');
    expect(thirdContext).toContain('old line');
  });

  it('append accumulates without requiring a read', async () => {
    const plane = fakePlane();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('append_file', { path: 'out.md', text: 'one' })]))
      .mockResolvedValueOnce(reply('', [toolCall('append_file', { path: 'out.md', text: 'two' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'appended' })]));
    const result = await runTask('grow the report', wsDeps({ chat, plane }));
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(plane.files.get('out.md')).toBe('onetwo');
  });

  it('reports exec failures as failed steps but still shows the output', async () => {
    const plane = fakePlane({ exec: async () => ({ code: 1, output: 'cat: nope.txt: No such file', timedOut: false, durationMs: 3 }) });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('exec', { cmd: 'cat nope.txt' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'handled' })]));
    const result = await runTask('read the file', wsDeps({ chat, plane }));
    expect(result.steps[0]).toMatchObject({ ok: false, detail: 'exit 1 (0.0s)' });

    const secondContext = (chat.mock.calls[1]![0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n');
    expect(secondContext).toContain('No such file');
  });

  it('surfaces a clear failure when workspace tools are called without a plane', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('exec', { cmd: 'ls' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'done what was possible without workspace tools' })]));
    const result = await runTask('list files', deps({ chat }));
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0]!.detail).toContain('workspace tools unavailable');
  });
});

describe('P2: plan + re-investigation + resume', () => {
  function wsDeps(over: Partial<LoopDeps> & { plane?: import('../../../local/plane.types').LocalPlane } = {}, taskId?: number): LoopDeps {
    const { plane, ...rest } = over;
    return deps({ ...rest, taskId, workspace: { plane: plane ?? fakePlane(), root: '/tmp/robots' } });
  }



  it('every task file lands in its task folder; skills stay shared and echoed paths roundtrip', async () => {
    const plane = fakePlane();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('write_file', { path: 'notes.md', content: 'x' })]))
      .mockResolvedValueOnce(reply('', [toolCall('write_file', { path: 'skills/my-skill/SKILL.md', content: 'y' })]))
      .mockResolvedValueOnce(reply('', [toolCall('append_file', { path: '.web-robot/tasks/5/notes.md', text: 'z' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'ok' })]));
    const result = await runTask('write files', wsDeps({ chat, plane }, 5));
    expect(result.status).toBe('done');
    expect(plane.files.has('notes.md')).toBe(false);
    expect(plane.files.get('.web-robot/tasks/5/notes.md')).toBe('xz');
    expect(plane.files.has('skills/my-skill/SKILL.md')).toBe(true);
    expect(result.steps[0]!.detail).toContain('created .web-robot/tasks/5/notes.md');
  });

  it('done summary lists touched files with absolute paths, PLAN.md excluded', async () => {
    const plane = fakePlane();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('update_plan', { items: [{ text: 'm1', done: false }] })]))
      .mockResolvedValueOnce(reply('', [toolCall('write_file', { path: 'report.md', content: '# t' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'saved the report' })]));
    const result = await runTask('save a file', wsDeps({ chat, plane }, 9));
    expect(result.summary).toContain('saved the report');
    expect(result.summary).toContain('**Files:**');
    expect(result.summary).toContain('`/tmp/robots/.web-robot/tasks/9/report.md`');
    expect(result.summary).not.toContain('PLAN.md');
    const plain = await runTask('nothing saved', wsDeps({ chat: vi.fn().mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'done' })])), plane: fakePlane() }, 10));
    expect(plain.summary).not.toContain('**Files:**');
  });





  it('a preamble (skill body) is injected as a system message', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    await runTask('t', deps({ chat, preamble: 'SKILL "alpha": do it this way.' }));
    const first = chat.mock.calls[0]![0] as import('../../../llm/chatClient').ChatMessage[];
    expect(first.some((m) => m.role === 'system' && m.content?.includes('SKILL "alpha"'))).toBe(true);
  });
});

describe('P4: tab ownership', () => {
  function tabDriver() {
    let next = 100;
    const closed: number[] = [];
    const opened: number[] = [];
    const driver = fakeDriver({
      act: async (action) => {
        if (action.type === 'new_tab') {
          const id = next++;
          opened.push(id);
          return { ok: true, detail: `opened tab ${id}`, data: { tabId: id } };
        }
        if (action.type === 'close_tab') {
          closed.push(action.tabId);
          return { ok: true, detail: `closed tab ${action.tabId}` };
        }
        return { ok: true, detail: 'done' };
      },
    });
    return { driver, closed, opened };
  }

  it('marks agent tabs, enforces the budget by closing the oldest, and cleans up at the end', async () => {
    const { driver, closed, opened } = tabDriver();
    const chat = vi.fn(async () => {
      const n = chat.mock.calls.length;
      if (n <= 7) return reply('', [toolCall('new_tab', { url: `https://site${n}.dev/page` })]);
      return reply('', [toolCall('done', { summary: 'opened a lot' })]);
    });
    const result = await runTask('open many tabs', deps({ driver, chat }));

    expect(result.status).toBe('done');
    expect(opened).toHaveLength(7);
    expect(closed[0]).toBe(100);
    expect(new Set(closed).size).toBe(closed.length); // no double closes
    expect(closed.length).toBe(7); // 1 budget eviction + 6 owned at end
  });

  it('skips cleanup when cleanupTabs is false', async () => {
    const { driver, closed } = tabDriver();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply('', [toolCall('new_tab', { url: 'https://a.dev' })]))
      .mockResolvedValueOnce(reply('', [toolCall('done', { summary: 'x' })]));
    await runTask('t', deps({ driver, chat, cleanupTabs: false }));
    expect(closed).toEqual([]);
  });
});

describe('exec spiral guard + rolling exec memory', () => {
  function wsDepsLocal(over: Partial<LoopDeps> & { plane?: import('../../../local/plane.types').LocalPlane } = {}): LoopDeps {
    const { plane, ...rest } = over;
    return deps({ ...rest, workspace: { plane: plane ?? fakePlane(), root: '/tmp/robots' } });
  }

  it('blocks a command after three identical consecutive failures', async () => {
    const plane = fakePlane({ exec: async (cmd: string) => (cmd.includes('mkdir') ? { code: 0, output: 'made', timedOut: false, durationMs: 3 } : { code: 23, output: 'curl: (23) Failed writing received data', timedOut: false, durationMs: 3 }) });
    let n = 0;
    const chat = vi.fn(async () => {
      n++;
      if (n <= 5) return reply('', [toolCall('exec', { cmd: 'curl -s http://x.dev -o scratch/posts.json' })]);
      return reply('', [toolCall('exec', { cmd: 'mkdir -p scratch' })]);
    });
    const result = await runTask('fetch it', wsDepsLocal({ chat, plane }));
    expect(result.steps.some((s) => !s.ok && s.detail.includes('identical failing command'))).toBe(true);
  });

  it('stops endless file-slicing execs (streak guard, then spiral fence)', async () => {
    const plane = fakePlane();
    const chat = vi.fn(async (_messages: import('../../../llm/chatClient').ChatMessage[], _tools: unknown[]) => {
      const n = chat.mock.calls.length;
      if (n <= 35) return reply('', [toolCall('exec', { cmd: `sed -n '1,${n}p' page1.txt` })]);
      return reply('', [toolCall('done', { summary: 'stopped slicing' })]);
    });
    const result = await runTask('parse the file', wsDepsLocal({ chat, plane }));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('exec probing');
    const blocked = result.steps.filter((s) => !s.ok && (s.detail.includes('spiral guard') || s.detail.includes('nothing recorded')));
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    const contexts = chat.mock.calls.map((c) => (c[0] as import('../../../llm/chatClient').ChatMessage[]).map((m) => m.content ?? '').join('\n'));
    expect(contexts.some((c) => c.includes('RECENT EXEC RESULTS'))).toBe(true);
  });

  it('keeps only the last 10 exec digests in context', async () => {
    const plane = fakePlane();
    let execs = 0;
    let calls = 0;
    const chat = vi.fn(async () => {
      calls++;
      if (calls > 15) return reply('', [toolCall('done', { summary: 'x' })]);
      if (calls % 4 === 0) return reply('', [toolCall('note', { text: `note ${calls}` })]);
      execs++;
      return reply('', [toolCall('exec', { cmd: `echo r${execs}` })]);
    });
    await runTask('t', wsDepsLocal({ chat: chat as never, plane }));
    const lastCall = chat.mock.calls.at(-1) as unknown as [import('../../../llm/chatClient').ChatMessage[]];
    const last = lastCall[0]!.map((m) => m.content ?? '').join('\n');
    const block = last.slice(last.lastIndexOf('RECENT EXEC RESULTS'));
    expect(execs).toBeGreaterThanOrEqual(11);
    expect(block).not.toContain('r1 ->');
    expect(block).not.toContain('r2 ->');
    expect(block).toContain('r3 ->');
    expect(block).toContain(`r${execs} ->`);
  });
});
