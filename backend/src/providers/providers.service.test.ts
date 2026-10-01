import { describe, expect, it } from 'vitest';
import { ProvidersService } from './providers.service';

function providersService(rows: Map<string, any> = new Map()) {
  const repo = {
    find: async () => [...rows.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.product.localeCompare(b.product)),
    findOneBy: async (where: { product?: string; active?: boolean }) =>
      [...rows.values()].find((r) => (where.product ? r.product === where.product : r.active === where.active)) ?? null,
    save: async (dto: any) => {
      rows.set(dto.product, { active: false, ...dto });
      return rows.get(dto.product);
    },
  };
  const em = {
    findOne: async (_e: unknown, o: { where: { product: string } }) => rows.get(o.where.product) ?? null,
    update: async (_e: unknown, where: { active?: boolean; product?: string }) => {
      for (const r of rows.values()) {
        if (where.active !== undefined && r.active === where.active) r.active = false;
        if (where.product !== undefined && r.product === where.product) r.active = true;
      }
      return { affected: 1 };
    },
  };
  const service = new ProvidersService(repo as never, { transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em) } as never);
  return { service, rows };
}

describe('ProvidersService', () => {
  it('upserts partial fields without clobbering the rest and lists with active first', async () => {
    const { service } = providersService();
    await service.upsert('glm', { apiKey: 'k1', baseUrl: 'https://z.ai', model: 'glm-5.3', effort: 'high' });
    await service.upsert('ollama', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'gpt-oss:20b' });
    await service.upsert('glm', { model: 'GLM-5.3-Flash' });
    const list = await service.list();
    expect(list.map((r) => r.product)).toEqual(['glm', 'ollama']);
    expect(list[0]).toMatchObject({ apiKey: 'k1', baseUrl: 'https://z.ai', model: 'GLM-5.3-Flash', effort: 'high', active: false });
  });

  it('activate flips the single active row and getActive returns it or 404s', async () => {
    const { service } = providersService();
    await expect(service.getActive()).rejects.toMatchObject({ status: 404 });
    await service.upsert('glm', { apiKey: 'k', baseUrl: 'u', model: 'm' });
    await service.upsert('ollama', { baseUrl: 'u', model: 'm' });
    await service.activate('ollama');
    await service.activate('glm');
    expect((await service.getActive()).product).toBe('glm');
    const list = await service.list();
    expect(list.find((r) => r.product === 'ollama')?.active).toBe(false);
    await expect(service.activate('ghost')).rejects.toMatchObject({ status: 404 });
  });
});
