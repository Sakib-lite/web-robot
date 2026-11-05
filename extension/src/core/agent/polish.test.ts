import { describe, expect, it } from 'vitest';
import { parsePolish, polishPrompt, polishSystemPrompt } from './polish';
import type { LlmProvider } from '../llm/providers';

describe('polishSystemPrompt', () => {
  it('encodes the system shape rules and the answer format', () => {
    const prompt = polishSystemPrompt();
    expect(prompt).toContain('spawn_agent');
    expect(prompt).toContain('one-item read-only research sub-agent');
    expect(prompt).toContain('python script with exec');
    expect(prompt).toContain('append each verified batch');
    expect(prompt).toContain('never from model memory');
    expect(prompt).toContain('establish the total first');
    expect(prompt).toContain('under 120 words');
    expect(prompt).toContain('no selenium');
    expect(prompt).toContain('ANALYSIS:');
    expect(prompt).toContain('PROMPT:');
  });
});

describe('parsePolish', () => {
  it('splits analysis bullets from the prompt body', () => {
    const parsed = parsePolish(
      'ANALYSIS:\n- per-item research across 3 languages\n- fan-out via sub-agents, parent writes the file\n\nPROMPT:\nUse spawn_agent once per language...',
    );
    expect(parsed.analysis).toEqual(['per-item research across 3 languages', 'fan-out via sub-agents, parent writes the file']);
    expect(parsed.prompt).toBe('Use spawn_agent once per language...');
  });

  it('strips code fences around the prompt', () => {
    const parsed = parsePolish('ANALYSIS:\n- shape: direct browsing\n\nPROMPT:\n```\nopen example.com and extract the table\n```');
    expect(parsed.prompt).toBe('open example.com and extract the table');
  });

  it('falls back to the whole reply when the model ignores the format', () => {
    const parsed = parsePolish('Just use spawn_agent per university and save admissions.md.');
    expect(parsed.analysis).toEqual([]);
    expect(parsed.prompt).toContain('spawn_agent');
  });
});

describe('polishPrompt', () => {
  const provider: LlmProvider = {
    productId: 'generic',
    baseUrl: 'http://llm.test',
    apiKey: '',
    model: 'm1',
  };

  it('sends the polishing contract and parses the reply', async () => {
    const content = 'ANALYSIS:\n- many items -> sub-agent fan-out\n\nPROMPT:\nUse spawn_agent once per item and append to out.md';
    let sentBody = '';
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const parsed = await polishPrompt('check all unis', provider, fetchFn);
    expect(parsed.analysis).toEqual(['many items -> sub-agent fan-out']);
    expect(parsed.prompt).toContain('Use spawn_agent');
    expect(sentBody).toContain('ANALYSIS:');
    expect(sentBody).toContain('check all unis');
  });

  it('rejects empty replies with a friendly error', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(polishPrompt('x', provider, fetchFn)).rejects.toThrow('polish reply was empty');
  });
});
