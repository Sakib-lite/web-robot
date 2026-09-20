import { useCallback, useEffect, useMemo, useState } from 'react';
import { chromeArea } from '@/core/storage/area';
import { createProductStore, type StoredProductConfig } from '@/core/llm/providers';

export function useProviders() {
  const store = useMemo(() => createProductStore(chromeArea()), []);
  const [configs, setConfigs] = useState<StoredProductConfig[] | null>(null);

  const refresh = useCallback(async () => {
    setConfigs(await store.list());
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { store, configs, refresh };
}
