import { useEffect, useRef, useState } from 'react';

export interface RecentTask {
  id: number;
  taskText: string;
  status: string;
  steps?: string[];
}

export interface ChatMessageRow {
  id: number;
  role: string;
  content: string;
  createdAt: string;
}

function previewOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 110);
}

export function Transcript({
  taskId,
  backendUrl,
  reloadKey,
  onLatest,
}: {
  taskId: number | '';
  backendUrl: string;
  reloadKey: number;
  onLatest?: (message: ChatMessageRow | null) => void;
}) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!taskId) {
      setMessages([]);
      onLatest?.(null);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`${backendUrl}/tasks/${taskId}/messages`)
      .then((res) => (res.ok ? res.json() : { messages: [] }))
      .then((body: { messages?: ChatMessageRow[] }) => {
        if (!alive) return;
        const rows = Array.isArray(body.messages) ? body.messages : [];
        setMessages(rows);
        onLatest?.(rows.length > 0 ? rows[rows.length - 1]! : null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [taskId, reloadKey, backendUrl]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <div className="chat-log">
      {loading && messages.length === 0 && <div className="muted small">loading conversation…</div>}
      {!loading && messages.length === 0 && (
        <div className="muted small">no messages yet - send the first one below</div>
      )}
      {messages.map((m) => (
        <details key={m.id} className={`msg msg-${m.role === 'agent' ? 'agent' : 'user'}`}>
          <summary>
            <span className="msg-arrow" aria-hidden="true" />
            <span className="msg-role">{m.role === 'agent' ? 'web-robot' : 'you'}</span>
            <span className="msg-preview">{previewOf(m.content)}</span>
            <span className="msg-time">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </summary>
          <div className="msg-body">{m.content}</div>
        </details>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

interface LiveCall {
  step: number;
  thinking: string | null;
  content: string;
  tool: string | null;
  error: string | null;
}

export function LiveProgress({ taskId, backendUrl, active }: { taskId: number | ''; backendUrl: string; active: boolean }) {
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!active || !taskId) {
      setCalls([]);
      setStatus('');
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`${backendUrl}/tasks/${taskId}/live`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const body = (await res.json()) as { status: string; calls: LiveCall[] };
        if (!alive) return;
        if (['done', 'failed', 'stopped', 'completed', 'canceled'].includes(body.status)) {
          setCalls([]);
          setStatus('');
          return;
        }
        setStatus(body.status);
        const all = body.calls.filter((c) => c.step > 0);
        const lastStart = all.map((c) => c.step).lastIndexOf(1);
        setCalls(lastStart >= 0 ? all.slice(lastStart) : all);
      } catch {
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, taskId, backendUrl]);

  if (!active || !taskId) return null;
  const actions = calls.filter((c) => c.tool && c.tool !== 'done');
  const finished = calls.some((c) => c.tool === 'done');

  return (
    <details className="run-block live" open>
      <summary>
        <span className={`run-dot ${status || 'queued'}`} />
        <span className="msg-role">
          {status || 'queued'} · {actions.length} action{actions.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="run-lines">
        {actions.length === 0 && !finished && <div className="muted small">starting…</div>}
        {actions.map((c, i) => (
          <div key={`${c.step}-${i}`} className="run-line">
            <span className="step-idx">{c.step}</span>
            <span className="step-call">{c.tool}</span>
            {c.error && <span className="muted"> {c.error.slice(0, 60)}</span>}
          </div>
        ))}
        {finished && (
          <div className="run-line">
            <span className="step-idx">✓</span>
            <span className="step-call">done</span>
          </div>
        )}
      </div>
    </details>
  );
}
