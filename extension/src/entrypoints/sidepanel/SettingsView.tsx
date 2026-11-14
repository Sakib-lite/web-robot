import { useEffect, useState } from 'react';
import { chatCompletion } from '@/core/llm/chatClient';
import { allProducts, type ProductId } from '@/core/llm/products';
import type { LlmProvider, ProductStore, StoredProductConfig } from '@/core/llm/providers';

interface CardState {
  apiKey: string;
  model: string;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: '' | 'low' | 'medium' | 'high';
}

type TestState = { productId: ProductId; ok: boolean; message: string } | null;

const EMPTY: Record<ProductId, CardState> = {
  glm: { apiKey: '', model: '', thinking: 'disabled', reasoningEffort: '' },
  openai: { apiKey: '', model: '', thinking: 'disabled', reasoningEffort: '' },
  generic: { apiKey: '', model: '', thinking: 'disabled', reasoningEffort: '' },
};

function cardFor(productId: ProductId, config: StoredProductConfig | undefined): CardState {
  if (!config) return EMPTY[productId];
  return {
    apiKey: config.apiKey,
    model: config.model,
    thinking: config.thinking ?? 'disabled',
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

export default function SettingsView({ store, configs, refresh }: { store: ProductStore; configs: StoredProductConfig[] | null; refresh: () => Promise<void> }) {
  const [cards, setCards] = useState<Record<ProductId, CardState>>(EMPTY);
  const [testState, setTestState] = useState<TestState>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!configs) return;
    setCards((prev) => {
      const next = { ...prev };
      for (const product of allProducts()) {
        next[product.id] = cardFor(product.id, configs.find((c) => c.productId === product.id));
      }
      return next;
    });
  }, [configs]);

  async function save(productId: ProductId) {
    const product = allProducts().find((p) => p.id === productId)!;
    const card = cards[productId];
    const existing = configs?.find((c) => c.productId === productId);
    try {
      await store.save({
        productId,
        baseUrl: existing?.baseUrl ?? product.defaults.baseUrl,
        apiKey: card.apiKey,
        model: card.model || product.defaults.model,
        ...(productId === 'glm' ? { thinking: card.thinking } : {}),
        ...(productId === 'openai' && card.reasoningEffort ? { reasoningEffort: card.reasoningEffort } : {}),
      });
      setTestState({ productId, ok: true, message: 'saved' });
      await refresh();
    } catch (error) {
      setTestState({ productId, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function test(productId: ProductId) {
    const existing = configs?.find((c) => c.productId === productId);
    if (!existing?.apiKey) {
      setTestState({ productId, ok: false, message: 'save an api key first' });
      return;
    }
    setTesting(true);
    setTestState({ productId, ok: true, message: 'testing…' });
    try {
      setTestState({ productId, ok: true, message: await runTest(existing) });
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
        return (
          <section key={product.id} className={config?.active ? 'product-card active' : 'product-card'}>
            <h2>
              {product.label}
              {config?.active ? <span className="badge">active</span> : null}
            </h2>
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
            <label>
              api key
              <input type="password" value={card.apiKey} onChange={(e) => setCards({ ...cards, [product.id]: { ...card, apiKey: e.target.value } })} placeholder={config?.apiKey ? 'saved' : 'paste key'} />
            </label>
            <label>
              model
              <input value={card.model} onChange={(e) => setCards({ ...cards, [product.id]: { ...card, model: e.target.value } })} placeholder={product.defaults.model} />
            </label>
            {product.id === 'glm' && (
              <label>
                thinking
                <select value={card.thinking} onChange={(e) => setCards({ ...cards, [product.id]: { ...card, thinking: e.target.value as 'enabled' | 'disabled' } })}>
                  <option value="disabled">off (faster)</option>
                  <option value="enabled">on (deep reasoning)</option>
                </select>
              </label>
            )}
            {product.id === 'openai' && (
              <label>
                reasoning effort
                <select value={card.reasoningEffort} onChange={(e) => setCards({ ...cards, [product.id]: { ...card, reasoningEffort: e.target.value as CardState['reasoningEffort'] } })}>
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
                <button disabled={!config} onClick={async () => { await store.activate(product.id); await refresh(); }}>
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
          </section>
        );
      })}
    </div>
  );
}
