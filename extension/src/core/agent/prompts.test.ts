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
  it('states the core rules in a compact prompt', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('one tool per turn');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('Partial results beat giving up');
    expect(prompt).toContain('never abandon the whole task');
    expect(prompt).not.toContain('update_plan');
  });

  it('scopes all file work to the task folder when one exists', () => {
    const prompt = systemPrompt('/tmp/robots', '.web-robot/tasks/9');
    expect(prompt).toContain('YOUR TASK FOLDER .web-robot/tasks/9/');
    expect(prompt).toContain('append each verified batch');
    expect(prompt).toContain('scratch/');
    const rootPrompt = systemPrompt('/tmp/robots');
    expect(rootPrompt).not.toContain('YOUR TASK FOLDER');
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

  it('omits old steps beyond ten to keep context lean', () => {
    const steps = Array.from({ length: 45 }, (_, i) => `step ${i + 1}`);
    const context = taskContext('t', steps, [], [], []);
    expect(context).toContain('first 35 omitted');
    expect(context).not.toContain('step 1\n');
    expect(context).toContain('36. step 36');
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

  it('caps notes at fifteen with an omission marker', () => {
    const notes = Array.from({ length: 45 }, (_, i) => `finding ${i + 1}`);
    const context = taskContext('t', [], [], [], notes);
    expect(context).toContain('first 30 older notes omitted');
    expect(context).toContain('31. finding 31');
    expect(context).toContain('45. finding 45');
    expect(context).not.toContain('finding 1\n');
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

  it('announces the next snapshot page when elements are windowed', () => {
    const paged = { ...snapshot, elementStart: 80, elementTotal: 200, elementsTruncated: true };
    const block = observationBlock([], paged);
    expect(block).toContain('showing 81-');
    expect(block).toContain('of 200');
    expect(block).toContain('snapshot with skip=');
  });

  it('directs the model back to a smaller skip past the end of the list', () => {
    const empty = { ...snapshot, elements: [], elementStart: 500, elementTotal: 200, elementsTruncated: false };
    const block = observationBlock([], empty);
    expect(block).toContain('0 shown');
    expect(block).toContain('smaller skip');
  });


  it('renders the aria tree in place of the flat list when present', () => {
    const treed = { ...snapshot, ariaTree: '- complementary\n  - button "PhD row title" [e38]\n    - checkbox "select" [e39]', elementStart: 37, elementTotal: 200, elementsTruncated: true };
    const block = observationBlock([], treed);
    expect(block).toContain('page tree');
    expect(block).toContain('- button "PhD row title" [e38]');
    expect(block).toContain('nested lines belong to their parent');
  });

  it('says all elements are shown when nothing is cut off', () => {
    const full = { ...snapshot, elementStart: 0, elementTotal: 2, elementsTruncated: false };
    expect(observationBlock([], full)).toContain('elements (all 2 shown)');
  });
});
