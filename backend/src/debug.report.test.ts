import { describe, expect, it } from 'vitest';
import { buildDebugReport, type TaskTrace } from './debug.report';

function trace(over: Partial<TaskTrace> = {}): TaskTrace {
  const createdAt = new Date('2026-11-14T08:00:00Z');
  return {
    task: {
      id: 1,
      task_text: 'list repos',
      status: 'failed',
      summary: null,
      reason: 'loop detected',
      product: 'glm',
      model: 'glm-5.3',
      effort: 'off',
      step_count: 3,
      created_at: createdAt,
      finished_at: new Date('2026-11-14T08:01:00Z'),
    },
    observations: [],
    llmCalls: [],
    actions: [],
    userAnswers: [],
    ...over,
  };
}

describe('buildDebugReport', () => {
  it('shapes the task summary with camelCase fields', () => {
    const report = buildDebugReport(trace());
    expect(report.task).toMatchObject({
      id: 1,
      taskText: 'list repos',
      status: 'failed',
      reason: 'loop detected',
      product: 'glm',
      stepCount: 3,
      finishedAt: '2026-11-14T08:01:00.000Z',
    });
  });

  it('orders the timeline by step then time', () => {
    const report = buildDebugReport(
      trace({
        observations: [{ step: 2, url: 'https://x.dev', title: 'X', page_text: 'text', elements: [], tabs: [], created_at: new Date('2026-11-14T08:00:20Z') }],
        llmCalls: [{ step: 2, messages: [], response_content: '', tool_calls: [], usage: {}, duration_ms: 500, error: null, created_at: new Date('2026-11-14T08:00:10Z') }],
        actions: [{ step: 1, tool: 'goto', args: { url: 'https://x.dev' }, ok: true, detail: 'navigated', duration_ms: 700, created_at: new Date('2026-11-14T08:00:05Z') }],
        userAnswers: [{ step: 3, question: 'which?', answer: 'that one', created_at: new Date('2026-11-14T08:00:30Z') }],
      }),
    );
    expect(report.timeline.map((e) => `${e.step}:${e.type}`)).toEqual(['1:action', '2:llm_call', '2:observation', '3:user_answer']);
  });

  it('collects failed actions, llm errors and the task reason into failures', () => {
    const report = buildDebugReport(
      trace({
        actions: [
          { step: 1, tool: 'goto', args: {}, ok: true, detail: 'ok', duration_ms: 5, created_at: new Date() },
          { step: 2, tool: 'click', args: { ref: 'e9' }, ok: false, detail: 'stale ref', duration_ms: 5, created_at: new Date() },
        ],
        llmCalls: [{ step: 3, messages: [], response_content: null, tool_calls: null, usage: null, duration_ms: null, error: 'llm request failed (429)', created_at: new Date() }],
      }),
    );
    expect(report.failures).toEqual([
      { step: 2, kind: 'action_failed', what: 'click: stale ref' },
      { step: 3, kind: 'llm_error', what: 'llm request failed (429)' },
      { step: 3, kind: 'task_failed', what: 'loop detected' },
    ]);
  });

  it('omits the failures section entries when nothing went wrong', () => {
    const report = buildDebugReport(trace({ task: { ...trace().task, status: 'done', reason: null, summary: 'listed' } }));
    expect(report.failures).toEqual([]);
  });
});
