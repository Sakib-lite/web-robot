import { useEffect, useRef, useState, type ReactNode } from 'react';
import { chatCompletion } from '@/core/llm/chatClient';
import { Chevron, Collapse } from './common/ui';
import { allProducts, type Effort, type ProductId } from '@/core/llm/products';
import type { LlmProvider, ProductStore, StoredProductConfig } from '@/core/llm/providers';
import { syncConfigToBackend } from '@/core/llm/providers';
import { DEFAULT_BACKEND_URL, getBackendUrl, isRemoteWorkerEnabled, saveBackendUrl, saveRemoteWorkerEnabled } from '@/core/telemetry/settings';

interface CardState {
  apiKey: string;
  model: string;
  thinking: Effort;
  reasoningEffort: '' | 'low' | 'medium' | 'high';
}

type TestState = { productId: ProductId; ok: boolean; message: string } | null;

const EMPTY: Record<ProductId, CardState> = {
  glm: { apiKey: '', model: '', thinking: 'off', reasoningEffort: '' },
  openai: { apiKey: '', model: '', thinking: 'off', reasoningEffort: '' },
  generic: { apiKey: '', model: '', thinking: 'off', reasoningEffort: '' },
  ollama: { apiKey: '', model: '', thinking: 'off', reasoningEffort: '' },
};

function cardFor(productId: ProductId, config: StoredProductConfig | undefined): CardState {
  if (!config) return EMPTY[productId];
  return {
    apiKey: config.apiKey,
    model: config.model,
    thinking: config.thinking ?? 'off',
    reasoningEffort: config.reasoningEffort ?? '',
  };
}

async function runTest(provider: LlmProvider): Promise<string> {
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
  return call ? `tool call ok: ${call.name}(${JSON.stringify(call.args)})` : `connected, but no tool call: ${res.content.slice(0, 80)}`;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export default function SettingsView({ store, configs, refresh }: { store: ProductStore; configs: StoredProductConfig[] | null; refresh: () => Promise<void> }) {
  const [cards, setCards] = useState<Record<ProductId, CardState>>(EMPTY);
  const [testState, setTestState] = useState<TestState>(null);
  const [testing, setTesting] = useState(false);
  const [backend, setBackend] = useState(DEFAULT_BACKEND_URL);
  const [workerOn, setWorkerOn] = useState(true);
  const [wsOn, setWsOn] = useState(true);
  const [wsRoot, setWsRoot] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<ProductId, boolean>>({ glm: true, openai: false, generic: false, ollama: false });
  const [secOpen, setSecOpen] = useState({ backend: true, worker: true, ws: true });
  const dirty = useRef(new Set<ProductId>());
  const openedActive = useRef(false);

  useEffect(() => {
    void (async () => {
      setBackend(await getBackendUrl());
      setWorkerOn(await isRemoteWorkerEnabled());
      await refresh();
      try {
        const res = await fetch(`${await getBackendUrl()}/workspace/status`);
        if (res.ok) {
          const status = (await res.json()) as { enabled: boolean; root: string };
          setWsOn(status.enabled);
          setWsRoot(status.root);
        }
      } catch {
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!configs) return;
    setCards((prev) => {
      const next = { ...prev };
      for (const product of allProducts()) {
        if (dirty.current.has(product.id)) continue;
        next[product.id] = cardFor(product.id, configs.find((c) => c.productId === product.id));
      }
      return next;
    });
    if (!openedActive.current) {
      const active = configs.find((c) => c.active);
      if (active) {
        setOpen({ glm: false, openai: false, generic: false, ollama: false, [active.productId]: true });
        openedActive.current = true;
      }
    }
  }, [configs]);

  function edit(productId: ProductId, patch: Partial<CardState>) {
    dirty.current.add(productId);
    setCards((prev) => ({ ...prev, [productId]: { ...prev[productId]!, ...patch } }));
  }

  async function pasteKey(productId: ProductId) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setTestState({ productId, ok: false, message: 'clipboard is empty' });
        return;
      }
      edit(productId, { apiKey: text.trim() });
      setTestState({ productId, ok: true, message: 'pasted from clipboard' });
    } catch (error) {
      setTestState({ productId, ok: false, message: `clipboard read failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function save(productId: ProductId) {
    const product = allProducts().find((p) => p.id === productId)!;
    const card = cards[productId];
    const existing = configs?.find((c) => c.productId === productId);
    try {
      const saved = await store.save({
        productId,
        baseUrl: existing?.baseUrl ?? product.defaults.baseUrl,
        apiKey: card.apiKey,
        model: card.model || product.defaults.model,
        ...(product.efforts ? { thinking: card.thinking } : {}),
        ...(productId === 'openai' && card.reasoningEffort ? { reasoningEffort: card.reasoningEffort } : {}),
      });
      try {
        await syncConfigToBackend(await getBackendUrl(), { ...saved, activate: saved.active });
      } catch {
      }
      setTestState({ productId, ok: true, message: 'saved' });
      dirty.current.delete(productId);
      await refresh();
    } catch (error) {
      setTestState({ productId, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function test(productId: ProductId) {
    const product = allProducts().find((p) => p.id === productId)!;
    const card = cards[productId];
    const existing = configs?.find((c) => c.productId === productId);
    const apiKey = card.apiKey || existing?.apiKey || '';
    if (!apiKey && !product.keyless) {
      setTestState({ productId, ok: false, message: 'paste an api key first' });
      return;
    }
    setTesting(true);
    setTestState({ productId, ok: true, message: 'testing…' });
    try {
      const provider: LlmProvider = {
        productId,
        baseUrl: existing?.baseUrl ?? product.defaults.baseUrl,
        apiKey,
        model: card.model || existing?.model || product.defaults.model,
        ...(product.efforts ? { thinking: card.thinking } : {}),
        ...(productId === 'openai' && card.reasoningEffort ? { reasoningEffort: card.reasoningEffort } : {}),
      };
      setTestState({ productId, ok: true, message: await runTest(provider) });
    } catch (error) {
      setTestState({ productId, ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings">
      {allProducts().map((product) => {
        const config = configs?.find((c) => c.productId === product.id);
        const card = cards[product.id];
        const note = testState?.productId === product.id ? testState : null;
        const isOpen = open[product.id] ?? false;
        const summary = config
          ? `${config.model}${product.id === 'glm' ? ` · ${config.thinking ?? 'off'}` : ''}`
          : 'not configured';
        return (
          <section key={product.id} className={config?.active ? 'product-card active' : 'product-card'}>
            <button type="button" className="card-head" onClick={() => setOpen((prev) => ({ ...prev, [product.id]: !isOpen }))} aria-expanded={isOpen}>
              <span className="card-title">
                {product.label}
                {config?.active ? <span className="badge">active</span> : null}
              </span>
              <span className="card-summary">{summary}</span>
              <Chevron open={isOpen} />
            </button>
            <Collapse open={isOpen}>
              <label>
                base url
                <input
                  value={config?.baseUrl ?? product.defaults.baseUrl}
                  onChange={async (e) => {
                    if (!config) return;
                    await store.save({ ...config, baseUrl: e.target.value });
                    await refresh();
                  }}
                />
              </label>
              {product.keyless ? (
                <p className="muted small">local server - no api key needed</p>
              ) : (
                <label>
                  api key
                  <div className="row">
                    <input
                      type="text"
                      className="key-input"
                      value={card.apiKey}
                      onChange={(e) => edit(product.id, { apiKey: e.target.value })}
                      placeholder={config?.apiKey ? 'saved' : 'paste or click ⌘v'}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button onClick={() => pasteKey(product.id)}>paste</button>
                  </div>
                </label>
              )}
              <label>
                model
                <input
                  list={`${product.id}-models`}
                  value={card.model}
                  onChange={(e) => edit(product.id, { model: e.target.value })}
                  placeholder={product.defaults.model}
                />
                <datalist id={`${product.id}-models`}>
                  {(product.models ?? [product.defaults.model]).map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </label>
              {product.efforts && (
                <label>
                  effort
                  <select value={card.thinking} onChange={(e) => edit(product.id, { thinking: e.target.value as Effort })}>
                    {product.efforts.map((level) => (
                      <option key={level} value={level}>
                        {level === 'off' ? 'off (fastest, no reasoning)' : level === 'max' ? 'max (deepest reasoning)' : level}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {product.id === 'openai' && (
                <label>
                  reasoning effort
                  <select value={card.reasoningEffort} onChange={(e) => edit(product.id, { reasoningEffort: e.target.value as CardState['reasoningEffort'] })}>
                    <option value="">default</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
              )}
              <div className="row">
                <button className="primary" onClick={() => save(product.id)}>
                  save
                </button>
                {!config?.active && (
                  <button
                    disabled={!config}
                    onClick={async () => {
                      await store.activate(product.id);
                      try {
                        await syncConfigToBackend(await getBackendUrl(), { ...(config as StoredProductConfig), activate: true });
                      } catch {
                      }
                      setOpen((prev) => ({ ...prev, [product.id]: true }));
                      await refresh();
                    }}
                  >
                    activate
                  </button>
                )}
                <button disabled={testing} onClick={() => test(product.id)}>
                  test
                </button>
                {config && (
                  <button
                    className="danger"
                    onClick={async () => {
                      await store.clear(product.id);
                      setCards({ ...cards, [product.id]: EMPTY[product.id] });
                      await refresh();
                    }}
                  >
                    clear
                  </button>
                )}
              </div>
              {note && <div className={note.ok ? 'note ok' : 'note err'}>{note.message}</div>}
            </Collapse>
          </section>
        );
      })}

      <section>
        <button type="button" className="card-head" onClick={() => setSecOpen((prev) => ({ ...prev, backend: !prev.backend }))} aria-expanded={secOpen.backend}>
          <span className="card-title">Debug backend</span>
          <span className="card-summary">telemetry + queue</span>
          <Chevron open={secOpen.backend} />
        </button>
        <Collapse open={secOpen.backend}>
          <p className="muted small">Every run is recorded there (steps, DOM, LLM thinking). Start it with `pnpm backend`.</p>
          <label>
            backend url
            <input value={backend} onChange={(e) => setBackend(e.target.value)} placeholder={DEFAULT_BACKEND_URL} />
          </label>
          <div className="row">
            <button
              className="primary"
              onClick={async () => {
                await saveBackendUrl(backend);
                setTestState({ productId: 'generic', ok: true, message: `backend saved: ${await getBackendUrl()}` });
              }}
            >
              save
            </button>
            {testState?.productId === 'generic' && <span className={testState.ok ? 'note ok' : 'note err'}>{testState.message}</span>}
          </div>
        </Collapse>
      </section>

      <section>
        <button type="button" className="card-head" onClick={() => setSecOpen((prev) => ({ ...prev, worker: !prev.worker }))} aria-expanded={secOpen.worker}>
          <span className="card-title">Remote worker</span>
          <span className="card-summary">{workerOn ? 'auto-runs queued tasks' : 'off'}</span>
          <Chevron open={secOpen.worker} />
        </button>
        <Collapse open={secOpen.worker}>
          <p className="muted small">
            Lets queued tasks from the debug backend run automatically in this browser. Turn off and the agent never claims work on its own.
          </p>
          <Switch
            checked={workerOn}
            label="run queued tasks automatically"
            onChange={async (next) => {
              setWorkerOn(next);
              await saveRemoteWorkerEnabled(next);
            }}
          />
        </Collapse>
      </section>

      <section>
        <button type="button" className="card-head" onClick={() => setSecOpen((prev) => ({ ...prev, ws: !prev.ws }))} aria-expanded={secOpen.ws}>
          <span className="card-title">Workspace tools</span>
          <span className="card-summary">{wsOn ? wsRoot ?? 'enabled' : 'disabled'}</span>
          <Chevron open={secOpen.ws} />
        </button>
        <Collapse open={secOpen.ws}>
          <p className="muted small">
            Lets the agent read/write files and run commands in the local workspace{wsRoot ? ` (${wsRoot})` : ''}, jailed to that folder. Turn off and every file/exec tool is refused by the backend.
          </p>
          <Switch
            checked={wsOn}
            label="allow file and command tools"
            onChange={async (next) => {
              setWsOn(next);
              try {
                const res = await fetch(`${await getBackendUrl()}/workspace/control`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ enabled: next }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
              } catch (error) {
                setWsOn(!next);
                setTestState({ productId: 'generic', ok: false, message: `workspace toggle failed: ${error instanceof Error ? error.message : String(error)}` });
              }
            }}
          />
        </Collapse>
      </section>
    </div>
  );
}
