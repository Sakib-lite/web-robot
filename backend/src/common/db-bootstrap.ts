import { Pool } from 'pg';
import { MIGRATIONS, SCHEMA_SQL } from './db.schema';

function baseConfig() {
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'root',
    password: process.env.PGPASSWORD ?? 'secret',
  };
}

async function ensureDatabase(): Promise<void> {
  const target = process.env.PGDATABASE ?? 'web_robot';
  const admin = new Pool({ ...baseConfig(), database: 'postgres', max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${target.replace(/"/g, '')}"`);
    }
  } finally {
    await admin.end();
  }
}

async function applySchema(): Promise<void> {
  const pool = new Pool({ ...baseConfig(), database: process.env.PGDATABASE ?? 'web_robot', max: 1 });
  try {
    await pool.query(SCHEMA_SQL);
    for (const migration of MIGRATIONS) {
      await pool.query(migration);
    }
  } finally {
    await pool.end();
  }
}

export async function prepareDatabase(): Promise<void> {
  await ensureDatabase();
  await applySchema();
}

export function typeormConfig() {
  return {
    type: 'postgres' as const,
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'root',
    password: process.env.PGPASSWORD ?? 'secret',
    database: process.env.PGDATABASE ?? 'web_robot',
    synchronize: false,
    entities: [`${__dirname}/../**/entities/*.entity.{js,ts}`],
  };
}
