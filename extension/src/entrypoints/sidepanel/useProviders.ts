import { useMemo, useState } from 'react';
import { chromeArea } from '@/core/storage/area';
import { createProviderStore, type LlmProvider } from '@/core/llm/providers';

export function useProviders() {
  const store = useMemo(() => createProviderStore(chromeArea()), []);
  const [providers, setProviders] = useState<LlmProvider[] | null>(null);

  async function refresh() {
    setProviders(await store.list());
  }

  return { store, providers, refresh };
}
