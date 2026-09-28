import { describe, expect, it } from 'vitest';
import { ProvidersService } from './providers.service';

function fakeDb() {
  const rows = new Map<string, { product: string; api_key: string | null; base_url: string | null; model: string | null; effort: string | null; active: boolean; updated_at: Date }>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT * FROM llm_providers WHERE active')) {
        const row = [...rows.values()].find((r) => r.active);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith('SELECT * FROM llm_providers ORDER')) {
        return { rows: [...rows.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.product.localeCompare(b.product)) };
      }
      if (sql.includes('ON CONFLICT (product) DO UPDATE')) {
        const [product, apiKey, baseUrl, model, effort] = params as [string, string | null, string | null, string | null, string | null];
        const prev = rows.get(product);
        rows.set(product, {
          product,
          api_key: apiKey ?? prev?.api_key ?? null,
          base_url: baseUrl ?? prev?.base_url ?? null,
          model: model ?? prev?.model ?? null,
          effort: effort ?? prev?.effort ?? null,
          active: prev?.active ?? false,
          updated_at: new Date(),
        });
        return { rows: [rows.get(product)] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
        if (sql.includes('FOR UPDATE')) {
          const row = rows.get(params[0] as string);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes('SET active = false')) {
          for (const r of rows.values()) r.active = false;
          return { rows: [] };
        }
        if (sql.includes('SET active = true')) {
          const row = rows.get(params[0] as string);
          if (row) row.active = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  const service = new ProvidersService({ pool } as never);
  return { service, rows };
}

describe('ProvidersService', () => {
  it('upserts partial fields without clobbering the rest and lists with active first', async () => {
    const { service } = fakeDb();
    await service.upsert('glm', { apiKey: 'k1', baseUrl: 'https://z.ai', model: 'glm-5.3', effort: 'high' });
    await service.upsert('ollama', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-oss:20b' });

    await service.upsert('glm', { model: 'GLM-5.3-Flash' });
    const glm = await service.list();
    expect(glm.map((r) => r.product)).toEqual(['glm', 'ollama']);
    expect(glm[0]).toMatchObject({ apiKey: 'k1', baseUrl: 'https://z.ai', model: 'GLM-5.3-Flash', effort: 'high', active: false });
  });

  it('activate flips the single active row and getActive returns it or 404s', async () => {
    const { service } = fakeDb();
    await expect(service.getActive()).rejects.toMatchObject({ status: 404 });
    await service.upsert('glm', { apiKey: 'k', baseUrl: 'u', model: 'm' });
    await service.upsert('ollama', { baseUrl: 'u', model: 'm' });
    await service.activate('ollama');
    await service.activate('glm');
    const active = await service.getActive();
    expect(active.product).toBe('glm');
    expect((await service.list()).find((r) => r.product === 'ollama')?.active).toBe(false);
    await expect(service.activate('ghost')).rejects.toMatchObject({ status: 404 });
  });
});
