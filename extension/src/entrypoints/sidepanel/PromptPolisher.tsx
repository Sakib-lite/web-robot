import { useState } from 'react';
import type { PolishedPrompt } from '@/core/agent/polish/polish';
import { Chevron, Collapse } from './common/ui';

export default function PromptPolisher({
  polish,
  onUse,
  disabled,
}: {
  polish: (input: string) => Promise<PolishedPrompt>;
  onUse: (prompt: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PolishedPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!input.trim() || busy) return;
    const draft = input;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await polish(draft));
      setInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="polisher">
      <button type="button" className="card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="card-title">polish prompt</span>
        <span className="card-summary">{result ? 'polished - review below' : 'rough idea in, tuned prompt out'}</span>
        <Chevron open={open} />
      </button>
      <Collapse open={open}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="rough idea, e.g. check admission reqs of the unis in my list and save them"
          rows={2}
          disabled={disabled || busy}
        />
        <div className="run-controls">
          <button className="primary" disabled={disabled || busy || !input.trim()} onClick={run}>
            {busy ? 'polishing…' : 'polish'}
          </button>
        </div>
        {error && <div className="note err">{error}</div>}
        {result && (
          <div className="result">
            <strong>analysis</strong>
            {result.analysis.length > 0 ? (
              <ul>
                {result.analysis.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <span className="muted small">(no analysis returned)</span>
            )}
            <strong>prompt</strong>
            <pre>{result.prompt}</pre>
            <div className="run-controls">
              <button className="primary" disabled={disabled} onClick={() => onUse(result.prompt)}>
                use as task
              </button>
            </div>
          </div>
        )}
      </Collapse>
    </div>
  );
}
