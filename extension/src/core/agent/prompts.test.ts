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
  });
});

describe('taskContext', () => {
  it('lists steps and user answers in order', () => {
    const context = taskContext('buy milk', ['goto https://shop.dev → ok'], ['question: which card?\nanswer: visa']);
    expect(context).toContain('TASK:\nbuy milk');
    expect(context).toContain('1. goto https://shop.dev → ok');
    expect(context).toContain('answer: visa');
  });

  it('stays compact when nothing happened yet', () => {
    expect(taskContext('buy milk', [], [])).toBe('TASK:\nbuy milk');
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
