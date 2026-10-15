import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, PoolConfig, types } from 'pg';
import { CONFIG, Config } from './config';

// int8 → number. Money is integer paise; 2^53 paise ≈ ₹90 trillion, so no precision risk.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

export type Queryable = Pool | PoolClient;

/**
 * DB_SSL: off (local docker) | verify (RDS / managed PG; checks the server cert against DB_SSL_CA)
 * | no-verify (encrypted but unchecked; avoid in prod).
 */
export function poolConfig(connectionString: string, max = 10): PoolConfig {
  const mode = process.env.DB_SSL ?? 'off';
  if (mode === 'off') return { connectionString, max };
  if (mode === 'no-verify') return { connectionString, max, ssl: { rejectUnauthorized: false } };
  const caFile = process.env.DB_SSL_CA || join(__dirname, '..', 'certs', 'rds-global-bundle.pem');
  return { connectionString, max, ssl: { rejectUnauthorized: true, ca: readFileSync(caFile, 'utf8') } };
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
function camelize<T>(row: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row)) o[camel(k)] = row[k];
  return o as T;
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.pool = new Pool(poolConfig(cfg.databaseUrl, cfg.dbPoolSize));
  }

  async many<T>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T[]> {
    const r = await q.query(sql, params);
    return r.rows.map((row) => camelize<T>(row));
  }

  async maybe<T>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T | null> {
    return (await this.many<T>(sql, params, q))[0] ?? null;
  }

  async one<T>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T> {
    const r = await this.maybe<T>(sql, params, q);
    if (r === null) throw new Error('Expected one row, got none');
    return r;
  }

  async exec(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<number> {
    return (await q.query(sql, params)).rowCount ?? 0;
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

/** Applies migrations/V*.sql in order, once each. Safe to run from several replicas. */
export async function migrate(pool: Pool, dir = join(__dirname, '..', 'migrations')) {
  const log = new Logger('migrate');
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(315315)');
    await c.query(
      'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await c.query('select version from schema_migrations')).rows.map((r) => r.version));
    const files = readdirSync(dir)
      .filter((f) => /^V\d+__.+\.sql$/.test(f))
      .sort((a, b) => Number(a.slice(1).split('__')[0]) - Number(b.slice(1).split('__')[0]));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('insert into schema_migrations (version) values ($1)', [f]);
        await c.query('COMMIT');
        log.log(`applied ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(315315)').catch(() => undefined);
    c.release();
  }
}
