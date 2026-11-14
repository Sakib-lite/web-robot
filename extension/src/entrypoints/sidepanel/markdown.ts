export interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { type: 'heading'; level: number; segments: InlineSegment[] }
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'list'; ordered: boolean; items: InlineSegment[][] };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index) });
    if (token.startsWith('**')) segments.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) segments.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('[')) {
      const bracket = token.indexOf(']');
      segments.push({ text: token.slice(1, bracket), href: token.slice(bracket + 2, -1) });
    } else segments.push({ text: token.slice(1, -1), italic: true });
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments.filter((segment) => segment.text !== '');
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', segments: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1]!.length, segments: parseInline(heading[2]!) });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list) list = { ordered: false, items: [] };
      else if (list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]!);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list) list = { ordered: true, items: [] };
      else if (!list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]!);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

export type DataView =
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'markdown'; blocks: Block[] }
  | { kind: 'json'; text: string };

export function describeData(data: unknown): DataView | null {
  if (data == null) return null;
  if (typeof data === 'string') return { kind: 'markdown', blocks: parseMarkdown(data) };
  if (Array.isArray(data)) {
    if (data.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return { kind: 'list', items: data.map((item) => String(item)) };
    }
    if (data.length > 0 && data.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
      const columns = [...new Set(data.flatMap((item) => Object.keys(item as Record<string, unknown>)))].slice(0, 6);
      const rows = data.map((item) => {
        const record = item as Record<string, unknown>;
        return columns.map((column) => String(record[column] ?? ''));
      });
      return { kind: 'table', columns, rows };
    }
  }
  return { kind: 'json', text: JSON.stringify(data, null, 2) };
}
