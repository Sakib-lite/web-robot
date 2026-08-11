import { useMemo, useState } from 'react';
import { chromeArea } from '@/core/storage/area';
import { createProductStore, type StoredProductConfig } from '@/core/llm/providers';
import type { ProductId } from '@/core/llm/products';

export function useProviders() {
  const store = useMemo(() => createProductStore(chromeArea()), []);
  const [configs, setConfigs] = useState<StoredProductConfig[] | null>(null);

  async function refresh() {
    setConfigs(await store.list());
  }

  return { store, configs, refresh };
}
