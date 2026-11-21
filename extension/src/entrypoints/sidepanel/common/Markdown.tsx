import { parseMarkdown, type Block, type InlineSegment } from '../markdown';

function Inline({ segment }: { segment: InlineSegment }) {
  if (segment.href) {
    return (
      <a href={segment.href} target="_blank" rel="noreferrer">
        {segment.text}
      </a>
    );
  }
  if (segment.code) return <code>{segment.text}</code>;
  if (segment.bold) return <strong>{segment.text}</strong>;
  if (segment.italic) return <em>{segment.text}</em>;
  return <>{segment.text}</>;
}

function Segments({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((segment, i) => (
        <Inline key={i} segment={segment} />
      ))}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const Tag = (['h3', 'h4', 'h5'] as const)[block.level - 1] ?? 'h5';
          return (
            <Tag key={i}>
              <Segments segments={block.segments} />
            </Tag>
          );
        }
        if (block.type === 'paragraph') {
          return (
            <p key={i}>
              <Segments segments={block.segments} />
            </p>
          );
        }
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Segments segments={item} />
              </li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <Blocks blocks={parseMarkdown(text)} />
    </div>
  );
}

export function MarkdownBlocks({ blocks }: { blocks: Block[] }) {
  return <Blocks blocks={blocks} />;
}
