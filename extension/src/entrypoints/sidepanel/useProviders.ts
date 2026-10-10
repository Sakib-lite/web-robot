import { useCallback, useEffect, useMemo, useState } from 'react';
import { chromeArea } from '@/core/storage/area';
import { createProductStore, type StoredProductConfig } from '@/core/llm/providers';
import type { ProductId } from '@/core/llm/products';

export function useProviders() {
  const store = useMemo(() => createProductStore(chromeArea()), []);
  const [configs, setConfigs] = useState<StoredProductConfig[] | null>(null);
  const [customModels, setCustomModels] = useState<Partial<Record<ProductId, string[]>>>({});

  const refresh = useCallback(async () => {
    setConfigs(await store.list());
    setCustomModels(await store.allCustomModels());
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { store, configs, customModels, refresh };
}
