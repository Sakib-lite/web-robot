import { describe, expect, it } from 'vitest';
import { parseCall, toolDefs } from './tools';

describe('toolDefs', () => {
  it('exposes every tool with a json schema object', () => {
    const defs = toolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toContain('click');
    expect(names).toContain('fill');
    expect(names).toContain('done');
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(5);
      expect(def.parameters.type).toBe('object');
      expect(def.parameters.$schema).toBeUndefined();
    }
  });
});

describe('parseCall', () => {
  it('parses a valid click call', () => {
    const res = parseCall('click', { ref: 'e3' });
    expect(res).toEqual({ ok: true, call: { kind: 'action', action: { type: 'click', ref: 'e3' } } });
  });

  it('parses goto, fill, scroll and wait', () => {
    expect(parseCall('goto', { url: 'https://x.dev' })).toEqual({
      ok: true,
      call: { kind: 'action', action: { type: 'goto', url: 'https://x.dev' } },
    });
    expect(parseCall('fill', { ref: 'e1', text: 'hello' })).toEqual({
      ok: true,
      call: { kind: 'action', action: { type: 'fill', ref: 'e1', text: 'hello' } },
    });
    expect(parseCall('scroll', { direction: 'down', amount: 400 })).toEqual({
      ok: true,
      call: { kind: 'action', action: { type: 'scroll', direction: 'down', amount: 400 } },
    });
    expect(parseCall('wait', { ms: 500 })).toEqual({
      ok: true,
      call: { kind: 'action', action: { type: 'wait', ms: 500 } },
    });
  });

  it('maps extract onto a real page action and snapshot onto observation', () => {
    expect(parseCall('extract', { goal: 'prices' })).toEqual({
      ok: true,
      call: { kind: 'action', action: { type: 'extract', goal: 'prices' } },
    });
    expect(parseCall('snapshot', {})).toEqual({ ok: true, call: { kind: 'observe' } });
  });

  it('parses control calls', () => {
    expect(parseCall('done', { summary: 'filled the form' })).toEqual({
      ok: true,
      call: { kind: 'done', summary: 'filled the form' },
    });
    expect(parseCall('fail', { reason: 'login required' })).toEqual({
      ok: true,
      call: { kind: 'fail', reason: 'login required' },
    });
    expect(parseCall('ask_user', { question: 'credentials?' })).toEqual({
      ok: true,
      call: { kind: 'ask_user', question: 'credentials?' },
    });
    expect(parseCall('note', { text: 'UIC: PTE 54' })).toEqual({
      ok: true,
      call: { kind: 'note', text: 'UIC: PTE 54' },
    });
  });

  it('rejects unknown tools and invalid arguments', () => {
    expect(parseCall('destroy', {})).toEqual({ ok: false, error: 'unknown tool: destroy' });
    const bad = parseCall('click', {});
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('invalid arguments for click');
    expect(parseCall('wait', { ms: 9000 }).ok).toBe(false);
  });
});
