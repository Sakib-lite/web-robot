import { Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  reason TEXT,
  product TEXT,
  model TEXT,
  effort TEXT,
  step_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS observations (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step INT NOT NULL,
  url TEXT,
  title TEXT,
  page_text TEXT,
  elements JSONB,
  tabs JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step INT NOT NULL,
  messages JSONB NOT NULL,
  response_content TEXT,
  tool_calls JSONB,
  usage JSONB,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS actions (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step INT NOT NULL,
  tool TEXT NOT NULL,
  args JSONB,
  ok BOOLEAN NOT NULL,
  detail TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_answers (
  id BIGSERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step INT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// idempotent additions for databases created before the feature landed
const MIGRATIONS = [
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skill TEXT`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0`,
];

@Injectable()
export class DbService implements OnModuleInit {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'root',
      password: process.env.PGPASSWORD ?? 'secret',
      database: process.env.PGDATABASE ?? 'web_robot',
      max: 5,
    });
  }

  async onModuleInit() {
    await this.ensureDatabase();
    await this.pool.query(SCHEMA_SQL);
    for (const migration of MIGRATIONS) {
      await this.pool.query(migration);
    }
  }

  private async ensureDatabase() {
    const target = process.env.PGDATABASE ?? 'web_robot';
    const admin = new Pool({
      host: this.pool.options.host,
      port: this.pool.options.port,
      user: this.pool.options.user,
      password: this.pool.options.password,
      database: 'postgres',
      max: 1,
    });
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${target.replace(/"/g, '')}"`);
      }
    } finally {
      await admin.end();
    }
  }
}
