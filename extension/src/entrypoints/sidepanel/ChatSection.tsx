import { useEffect, useRef, useState } from 'react';
import { Chevron, Collapse } from './common/ui';

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

export function ChatSection({
  recentTasks,
  chatTaskId,
  chatInput,
  chatState,
  open,
  running,
  reloadKey,
  backendUrl,
  onToggle,
  onPick,
  onInput,
  onSend,
  onKill,
}: {
  recentTasks: RecentTask[];
  chatTaskId: number | '';
  chatInput: string;
  chatState: string | null;
  open: boolean;
  running: boolean;
  reloadKey: number;
  backendUrl: string;
  onToggle: () => void;
  onPick: (id: number | '') => void;
  onInput: (value: string) => void;
  onSend: () => void;
  onKill: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!chatTaskId) {
      setMessages([]);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`${backendUrl}/tasks/${chatTaskId}/messages`)
      .then((res) => (res.ok ? res.json() : { messages: [] }))
      .then((body: { messages?: ChatMessageRow[] }) => {
        if (alive) setMessages(Array.isArray(body.messages) ? body.messages : []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chatTaskId, reloadKey, backendUrl]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (recentTasks.length === 0) return null;

  return (
    <div className="chat-section">
      <button type="button" className="card-head" onClick={onToggle} aria-expanded={open}>
        <span className="card-title">chat / continue a task</span>
        <span className="card-summary">{chatTaskId ? `#${chatTaskId} · ${messages.length} messages` : `${recentTasks.length} recent`}</span>
        <Chevron open={open} />
      </button>
      <Collapse open={open}>
        <div className="chat-bar">
          <div className="row">
            <select value={chatTaskId} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : '')} disabled={running}>
              {chatTaskId === '' && <option value="">pick task…</option>}
              {recentTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.id} · {t.status} · {t.taskText.slice(0, 40)}
                </option>
              ))}
            </select>
            <input
              value={chatInput}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSend();
              }}
              placeholder={chatTaskId ? `message task #${chatTaskId} - it keeps the full conversation` : 'pick a task above first'}
              disabled={running || !chatTaskId}
            />
            <button className="primary" onClick={onSend} disabled={running || !chatTaskId || !chatInput.trim()}>
              send
            </button>
            <button className="danger" onClick={onKill} disabled={!chatTaskId} title="mark this task stopped and reload the extension - stops any in-flight run">
              kill
            </button>
          </div>
          {chatState && <div className="muted small">{chatState}</div>}
        </div>
        {chatTaskId !== '' && (
          <div className="chat-log">
            {loading && messages.length === 0 && <div className="muted small">loading conversation…</div>}
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
                <span className="bubble-role">{m.role === 'agent' ? 'web-robot' : 'you'}</span>
                <span className="bubble-text">{m.content}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </Collapse>
    </div>
  );
}
