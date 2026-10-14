import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CONFIG, Config } from '../config';
import { Db, Queryable } from '../db';

export interface JobHandler {
  readonly type: string;
  handle(payload: any): Promise<void>;
}

const MAX_ATTEMPTS = 8;

/**
 * Transactional outbox. Enqueue inside the same transaction as the state change,
 * so a committed booking always has its notifications/refunds queued (C3).
 */
@Injectable()
export class Jobs {
  private readonly log = new Logger('jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;

  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  register(h: JobHandler) {
    this.handlers.set(h.type, h);
  }

  enqueue(q: Queryable, type: string, payload: object, delaySec = 0) {
    return this.db.exec(
      `insert into job (type, payload, run_at) values ($1, $2::jsonb, now() + make_interval(secs => $3))`,
      [type, JSON.stringify(payload), delaySec],
      q,
    );
  }

  @Interval(2000)
  async drain() {
    if (this.running || !this.cfg.jobsEnabled) return;
    this.running = true;
    try {
      for (let i = 0; i < 20 && (await this.runOne()); i++);
    } catch (e) {
      this.log.error('drain failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /** Handlers must be idempotent: a crash after the side effect but before commit re-runs it. */
  async runOne(): Promise<boolean> {
    return this.db.tx(async (c) => {
      const job = await this.db.maybe<{ id: number; type: string; payload: any; attempts: number }>(
        `select id, type, payload, attempts from job
         where done_at is null and run_at <= now() order by id limit 1 for update skip locked`,
        [],
        c,
      );
      if (!job) return false;
      try {
        const h = this.handlers.get(job.type);
        if (!h) throw new Error(`No handler for job type ${job.type}`);
        await h.handle(job.payload);
        await c.query('update job set done_at = now(), attempts = attempts + 1 where id = $1', [job.id]);
      } catch (e) {
        const attempts = job.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await c.query(
          `update job set attempts = $2, last_error = $3, dead = $4,
                  done_at = case when $4 then now() end,
                  run_at = now() + make_interval(secs => $5)
           where id = $1`,
          [job.id, attempts, String((e as Error)?.message ?? e).slice(0, 1000), dead, Math.min(3600, 10 * 2 ** attempts)],
        );
        (dead ? this.log.error : this.log.warn).call(this.log, `job ${job.id} ${job.type} attempt ${attempts} failed: ${e}`);
      }
      return true;
    });
  }
}
