import { describeData } from './markdown';
import { Markdown, MarkdownBlocks } from './common/Markdown';
import type { TaskResult } from '@/core/agent/loop';

export default function ResultView({ result }: { result: TaskResult }) {
  const data = describeData(result.data);
  return (
    <div className={result.status === 'done' ? 'note ok result' : 'note err result'}>
      <strong>{result.status}</strong>
      {result.summary ? (
        <div className="result-summary">
          <Markdown text={result.summary} />
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
          <MarkdownBlocks blocks={data.blocks} />
        </div>
      )}
      {data?.kind === 'json' && <pre className="data">{data.text}</pre>}
    </div>
  );
}
