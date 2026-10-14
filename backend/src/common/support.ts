import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { PoolClient } from 'pg';
import { CONFIG, Config } from '../config';
import { Db, Queryable } from '../db';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, data: string | Buffer, enc: 'hex' | 'base64' = 'hex') =>
  createHmac('sha256', secret).update(data).digest(enc);
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** AES-256-GCM for bank account / PAN at rest. Layout: iv(12) | tag(16) | ciphertext. */
@Injectable()
export class Crypto {
  private readonly key: Buffer;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.key = Buffer.from(cfg.cryptoKey, 'base64');
    if (this.key.length !== 32) throw new Error('CRYPTO_KEY must be 32 bytes, base64-encoded');
  }

  encrypt(plain: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  decrypt(b: Buffer): string {
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
}

/** Runtime business config (app_config table), editable by admin. */
@Injectable()
export class Settings {
  constructor(private readonly db: Db) {}

  async get(key: string, q?: Queryable): Promise<string> {
    const r = await this.db.maybe<{ value: string }>('select value from app_config where key = $1', [key], q);
    if (!r) throw new Error(`Missing app_config ${key}`);
    return r.value;
  }
  async int(key: string, q?: Queryable) {
    return Number(await this.get(key, q));
  }
  async bool(key: string, q?: Queryable) {
    return (await this.get(key, q)) === 'true';
  }
  all() {
    return this.db.many<{ key: string; value: string }>('select key, value from app_config order by key');
  }
}

@Injectable()
export class Audit {
  constructor(private readonly db: Db) {}

  log(q: Queryable, actorId: string, action: string, entity: string, entityId: string | null, before?: unknown, after?: unknown) {
    return this.db.exec(
      `insert into audit_log (actor_id, action, entity, entity_id, before, after)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [actorId, action, entity, entityId, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)],
      q,
    );
  }
}

/** Stable human references, e.g. BK-2026-000123 (PDF: internal transaction ID). */
@Injectable()
export class Refs {
  constructor(private readonly db: Db) {}

  async next(prefix: string, q?: Queryable) {
    const { n } = await this.db.one<{ n: number }>(`select nextval('ref_seq') as n`, [], q);
    return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;
  }
}

/** Only one replica runs a scheduled task per tick. */
export async function tryXactLock(c: PoolClient, key: number): Promise<boolean> {
  return (await c.query('select pg_try_advisory_xact_lock($1) as ok', [key])).rows[0].ok;
}

export const LOCKS = { holdExpiry: 1, eligibility: 2, matching: 3 } as const;
