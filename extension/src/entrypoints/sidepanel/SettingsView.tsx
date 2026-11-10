import { useEffect, useState } from 'react';
import { chatCompletion } from '@/core/llm/chatClient';
import type { LlmProvider } from '@/core/llm/providers';
import type { useProviders } from './useProviders';

type Draft = Pick<LlmProvider, 'name' | 'baseUrl' | 'apiKey' | 'model' | 'visionModel'> & { id?: string };

const EMPTY: Draft = { name: '', baseUrl: '', apiKey: '', model: '', visionModel: '' };

const PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'Z.ai GLM', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.7' },
  { label: 'BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-4o-mini' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
];

export default function SettingsView({ providers, store, refresh }: ReturnType<typeof useProviders>) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [testState, setTestState] = useState<{ providerId: string; message: string; ok: boolean } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    try {
      await store.save(draft);
      setDraft(EMPTY);
      await refresh();
    } catch (error) {
      setTestState({ providerId: 'form', ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function test(provider: LlmProvider) {
    setTesting(true);
    setTestState({ providerId: provider.id, ok: true, message: 'testing…' });
    try {
      const res = await chatCompletion(provider, {
        messages: [{ role: 'user', content: 'Call the reply_with tool with text "web-robot alive".' }],
        tools: [
          {
            name: 'reply_with',
            description: 'Reply with exactly the given text.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
        maxTokens: 300,
      });
      const call = res.toolCalls[0];
      const message = call
        ? `tool call ok: ${call.name}(${JSON.stringify(call.args)})`
        : `connected, but no tool call: ${res.content.slice(0, 80)}`;
      setTestState({ providerId: provider.id, ok: !!call, message });
    } catch (error) {
      setTestState({ providerId: provider.id, ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings">
      <section>
        <h2>Providers</h2>
        {providers === null && <p className="muted">loading…</p>}
        {providers?.length === 0 && <p className="muted">no providers yet - add one below</p>}
        <ul className="provider-list">
          {providers?.map((p) => (
            <li key={p.id} className={p.active ? 'provider active' : 'provider'}>
              <div className="provider-main">
                <div>
                  <strong>{p.name}</strong> <span className="muted">{p.model}</span>
                </div>
                <div className="muted small">
                  {p.baseUrl} {p.active ? '· active' : ''}
                </div>
              </div>
              <div className="provider-actions">
                {!p.active && (
                  <button
                    onClick={async () => {
                      await store.activate(p.id);
                      await refresh();
                    }}
                  >
                    activate
                  </button>
                )}
                <button disabled={testing} onClick={() => test(p)}>
                  test
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    await store.remove(p.id);
                    await refresh();
                  }}
                >
                  delete
                </button>
              </div>
              {testState?.providerId === p.id && <div className={testState.ok ? 'note ok' : 'note err'}>{testState.message}</div>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>{draft.id ? 'Edit provider' : 'Add provider'}</h2>
        <div className="presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              className="chip"
              onClick={() => setDraft({ ...draft, baseUrl: preset.baseUrl, model: preset.model, name: draft.name || preset.label })}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label>
          name
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Z.ai GLM" />
        </label>
        <label>
          base url
          <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.z.ai/api/coding/paas/v4" />
        </label>
        <label>
          api key
          <input type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder="sk-…" />
        </label>
        <label>
          model
          <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="glm-4.7" />
        </label>
        <label>
          vision model <span className="muted">(optional)</span>
          <input value={draft.visionModel ?? ''} onChange={(e) => setDraft({ ...draft, visionModel: e.target.value })} placeholder="glm-4.5v" />
        </label>
        <div className="row">
          <button className="primary" onClick={save}>
            save
          </button>
          {draft.id && (
            <button
              onClick={() => {
                setDraft(EMPTY);
              }}
            >
              cancel
            </button>
          )}
          {testState?.providerId === 'form' && <span className={testState.ok ? 'note ok' : 'note err'}>{testState.message}</span>}
        </div>
      </section>
    </div>
  );
}
