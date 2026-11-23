import { describe, expect, it } from 'vitest';
import { describeData, parseInline, parseMarkdown } from '../markdown';

describe('parseInline', () => {
  it('leaves plain text untouched', () => {
    expect(parseInline('just words')).toEqual([{ text: 'just words' }]);
  });

  it('parses bold, italic, code and links in one line', () => {
    expect(parseInline('**key** fact with `code` and *emphasis*')).toEqual([
      { text: 'key', bold: true },
      { text: ' fact with ' },
      { text: 'code', code: true },
      { text: ' and ' },
      { text: 'emphasis', italic: true },
    ]);
    expect(parseInline('see [docs](https://x.dev/a) here')).toEqual([
      { text: 'see ' },
      { text: 'docs', href: 'https://x.dev/a' },
      { text: ' here' },
    ]);
  });

  it('ignores non-http links', () => {
    expect(parseInline('[bad](javascript:alert(1))')).toEqual([{ text: '[bad](javascript:alert(1))' }]);
  });
});

describe('parseMarkdown', () => {
  it('groups consecutive bullets into an unordered list', () => {
    const blocks = parseMarkdown('- one\n- two\n- three');
    expect(blocks).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [
          [{ text: 'one' }],
          [{ text: 'two' }],
          [{ text: 'three' }],
        ],
      },
    ]);
  });

  it('groups numbered lines into an ordered list', () => {
    const blocks = parseMarkdown('1. first\n2. second');
    expect(blocks).toEqual([
      { type: 'list', ordered: true, items: [[{ text: 'first' }], [{ text: 'second' }]] },
    ]);
  });

  it('separates lists and paragraphs and switches list types', () => {
    const blocks = parseMarkdown('Intro line\n- a\n- b\n1. redo\n2. again\n\nOutro');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'list', 'paragraph']);
    expect(blocks[1]).toMatchObject({ ordered: false });
    expect(blocks[2]).toMatchObject({ ordered: true });
  });

  it('renders headings with levels', () => {
    const blocks = parseMarkdown('## Title\nbody');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    expect(blocks[1]).toMatchObject({ type: 'paragraph' });
  });

  it('joins wrapped paragraph lines', () => {
    const blocks = parseMarkdown('first line\nsecond line');
    expect(blocks).toEqual([{ type: 'paragraph', segments: [{ text: 'first line second line' }] }]);
  });

  it('carries inline formatting into list items', () => {
    const blocks = parseMarkdown('- **web-robot**: agent');
    expect(blocks[0]).toMatchObject({
      type: 'list',
      items: [[{ text: 'web-robot', bold: true }, { text: ': agent' }]],
    });
  });
});

describe('describeData', () => {
  it('returns null for missing data', () => {
    expect(describeData(null)).toBeNull();
    expect(describeData(undefined)).toBeNull();
  });

  it('renders primitive arrays as lists', () => {
    expect(describeData(['web-robot', 'resume-server'])).toEqual({
      kind: 'list',
      items: ['web-robot', 'resume-server'],
    });
  });

  it('renders object arrays as tables with union columns', () => {
    const view = describeData([{ name: 'web-robot', stars: 2 }, { name: 'stopwatch' }]);
    expect(view).toEqual({
      kind: 'table',
      columns: ['name', 'stars'],
      rows: [
        ['web-robot', '2'],
        ['stopwatch', ''],
      ],
    });
  });

  it('renders markdown strings', () => {
    expect(describeData('- a\n- b')).toMatchObject({ kind: 'markdown' });
  });

  it('falls back to json for everything else', () => {
    expect(describeData({ nested: true })).toEqual({ kind: 'json', text: '{\n  "nested": true\n}' });
    expect(describeData([1, { mixed: true }])).toMatchObject({ kind: 'json' });
  });
});
