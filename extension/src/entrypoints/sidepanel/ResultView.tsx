import { describeData, parseMarkdown, type Block, type InlineSegment } from './markdown';
import type { TaskResult } from '@/core/agent/loop';

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

export default function ResultView({ result }: { result: TaskResult }) {
  const data = describeData(result.data);
  return (
    <div className={result.status === 'done' ? 'note ok result' : 'note err result'}>
      <strong>{result.status}</strong>
      {result.summary ? (
        <div className="result-summary">
          <Blocks blocks={parseMarkdown(result.summary)} />
        </div>
      ) : result.reason ? (
        <p>{result.reason}</p>
      ) : null}

      {data?.kind === 'list' && (
        <ul className="result-data">
          {data.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {data?.kind === 'table' && (
        <table className="result-data">
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.kind === 'markdown' && (
        <div className="result-data">
          <Blocks blocks={data.blocks} />
        </div>
      )}
      {data?.kind === 'json' && <pre className="data">{data.text}</pre>}
    </div>
  );
}
