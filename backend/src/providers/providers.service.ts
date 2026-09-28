import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DbService } from '../common/db.service';

export interface ProviderRow {
  product: string;
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
  effort: string | null;
  active: boolean;
  updatedAt: Date;
}

interface DbRow {
  product: string;
  api_key: string | null;
  base_url: string | null;
  model: string | null;
  effort: string | null;
  active: boolean;
  updated_at: Date;
}

function toRow(r: DbRow): ProviderRow {
  return {
    product: r.product,
    apiKey: r.api_key,
    baseUrl: r.base_url,
    model: r.model,
    effort: r.effort,
    active: r.active,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ProvidersService implements OnModuleInit {
  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    await this.db.pool.query(
      `CREATE TABLE IF NOT EXISTS llm_providers (
        product TEXT PRIMARY KEY,
        api_key TEXT,
        base_url TEXT,
        model TEXT,
        effort TEXT,
        active BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
  }

  async list(): Promise<ProviderRow[]> {
    const res = await this.db.pool.query(`SELECT * FROM llm_providers ORDER BY active DESC, product`);
    return res.rows.map(toRow);
  }

  async getActive(): Promise<ProviderRow> {
    const res = await this.db.pool.query(`SELECT * FROM llm_providers WHERE active = true LIMIT 1`);
    if (res.rows.length === 0) throw new NotFoundException('no active llm provider');
    return toRow(res.rows[0]);
  }

  async upsert(product: string, fields: { apiKey?: string; baseUrl?: string; model?: string; effort?: string }): Promise<ProviderRow> {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(product)) throw new NotFoundException(`bad product "${product}"`);
    const res = await this.db.pool.query(
      `INSERT INTO llm_providers (product, api_key, base_url, model, effort, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (product) DO UPDATE SET
         api_key = COALESCE($2, llm_providers.api_key),
         base_url = COALESCE($3, llm_providers.base_url),
         model = COALESCE($4, llm_providers.model),
         effort = COALESCE($5, llm_providers.effort),
         updated_at = now()
       RETURNING *`,
      [product, fields.apiKey ?? null, fields.baseUrl ?? null, fields.model ?? null, fields.effort ?? null],
    );
    return toRow(res.rows[0]);
  }

  async activate(product: string): Promise<ProviderRow> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT * FROM llm_providers WHERE product = $1 FOR UPDATE`, [product]);
      if (current.rows.length === 0) throw new NotFoundException(`product "${product}" is not configured`);
      await client.query(`UPDATE llm_providers SET active = false WHERE active = true`);
      await client.query(`UPDATE llm_providers SET active = true, updated_at = now() WHERE product = $1`, [product]);
      await client.query('COMMIT');
      return toRow(current.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
