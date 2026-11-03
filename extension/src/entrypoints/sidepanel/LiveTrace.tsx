import { useEffect, useRef, useState } from 'react';
import { getBackendUrl } from '@/core/telemetry/settings';

interface LiveCall {
  step: number;
  thinking: string | null;
  content: string;
  tool: string | null;
  error: string | null;
}

export function LiveTrace({ taskId }: { taskId: number | null }) {
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [status, setStatus] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (taskId === null) {
      setCalls([]);
      return;
    }
    let cancelled = false;
    let lastId = 0;
    const poll = async () => {
      try {
        const base = await getBackendUrl();
        const res = await fetch(`${base}/tasks/${taskId}/live`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const body = (await res.json()) as { status: string; calls: LiveCall[] };
        if (cancelled) return;
        setStatus(body.status);
        const fresh = body.calls.filter((c) => c.step > 0).slice(-6);
        setCalls((prev) => {
          if (prev.length && fresh.length && prev[prev.length - 1]!.step === fresh[fresh.length - 1]!.step && prev.length >= fresh.length) {
            return prev.length === fresh.length ? prev : fresh;
          }
          return fresh;
        });
        void lastId;
      } catch {
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [calls]);

  if (taskId === null || calls.length === 0) return null;

  return (
    <section className="live-trace" aria-label={`live trace of task ${taskId}`}>
      <div className="live-trace-head">
        <span className="spinner" aria-hidden /> task #{taskId} · {status || 'running'}
      </div>
      <div className="live-trace-body">
        {calls.map((call) => (
          <div key={call.step} className="live-step">
            <div className="live-step-call">
              #{call.step} {call.error ? <span className="muted">error</span> : call.tool ?? (call.content ? 'reply' : '…')}
            </div>
            {call.thinking && <pre className="live-thinking">{call.thinking}</pre>}
            {!call.thinking && call.content && <div className="muted small live-content">{call.content.slice(0, 140)}</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
