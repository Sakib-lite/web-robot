import { describe, expect, it } from 'vitest';
import { observationBlock, systemPrompt, taskContext } from './prompts';
import type { Snapshot } from '../driver/types';

const snapshot: Snapshot = {
  url: 'https://shop.dev/cart',
  title: 'Cart',
  text: 'Your cart has 2 items.',
  elements: [
    { ref: 'e1', tag: 'button', kind: 'button', name: 'Place order' },
    { ref: 'e2', tag: 'input', kind: 'textbox', name: 'Coupon', value: 'SAVE10' },
  ],
};

describe('systemPrompt', () => {
  it('states the core loop rules', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('one tool per turn');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('pagination');
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('scoped failure');
    expect(prompt).toContain('partial result');
    expect(prompt).toContain('reworded');
    // the phd.com lesson: totality must be proven, never assumed
    expect(prompt).toContain('COMPLETENESS');
    expect(prompt).toContain('Never claim complete coverage you have not verified');
  });

  it('scopes all file work to the task folder when one exists', () => {
    const prompt = systemPrompt('/tmp/robots', '.web-robot/tasks/9');
    expect(prompt).toContain("THIS TASK'S FOLDER is .web-robot/tasks/9/");
    expect(prompt).toContain('every file you create');
    expect(prompt).toContain('TOP LEVEL of your task folder');
    expect(prompt).toContain('scratch/ in your task folder');
    // without a task folder the old workspace-root conventions stay
    const rootPrompt = systemPrompt('/tmp/robots');
    expect(rootPrompt).not.toContain("THIS TASK'S FOLDER");
    expect(rootPrompt).toContain('<topic>-<date>/" folder');
  });
});

describe('taskContext', () => {
  it('lists steps and user answers in order', () => {
    const context = taskContext('buy milk', ['goto https://shop.dev → ok'], ['question: which card?\nanswer: visa'], []);
    expect(context).toContain('TASK:\nbuy milk');
    expect(context).toContain('1. goto https://shop.dev → ok');
    expect(context).toContain('answer: visa');
  });

  it('stays compact when nothing happened yet', () => {
    expect(taskContext('buy milk', [], [], [])).toBe('TASK:\nbuy milk');
  });

  it('omits old steps beyond thirty to keep context lean', () => {
    const steps = Array.from({ length: 45 }, (_, i) => `step ${i + 1}`);
    const context = taskContext('t', steps, [], [], []);
    expect(context).toContain('first 15 omitted');
    expect(context).not.toContain('step 1\n');
    expect(context).toContain('16. step 16');
    expect(context).toContain('45. step 45');
  });

  it('shows the latest extract in full and older ones as snippets', () => {
    const extracts = [
      { goal: 'page 1 repos', text: 'A'.repeat(300) },
      { goal: 'page 2 repos', text: 'B'.repeat(300) },
    ];
    const context = taskContext('list repos', [], [], extracts);
    expect(context).toContain('EXTRACTED CONTENT:');
    expect(context).toContain(`[1] page 1 repos: ${'A'.repeat(150)}`);
    expect(context).toContain('[latest] page 2 repos:');
    expect(context).toContain('B'.repeat(300));
  });
});

describe('observationBlock', () => {
  it('renders tabs, elements and page text', () => {
    const block = observationBlock([{ id: 7, url: 'https://shop.dev/cart', title: 'Cart', active: true }], snapshot);
    expect(block).toContain('url: https://shop.dev/cart');
    expect(block).toContain('* [7] Cart https://shop.dev/cart');
    expect(block).toContain('[e1] button "Place order"');
    expect(block).toContain('[e2] textbox "Coupon" value="SAVE10"');
    expect(block).toContain('Your cart has 2 items.');
  });

  it('reports a missing page instead of crashing', () => {
    expect(observationBlock([], null)).toContain('no accessible page');
  });
});
