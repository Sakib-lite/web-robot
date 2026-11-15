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
        <div key={m.id} className={`bubble ${m.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
          <span className="bubble-role">{m.role === 'agent' ? 'web-robot' : 'you'}</span>
          <span className="bubble-text">{m.content}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
