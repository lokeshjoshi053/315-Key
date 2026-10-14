import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject, Injectable, Logger, OnModuleInit, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { readFileSync } from 'fs';
import { CONFIG, Config } from '../config';
import { Db, Queryable } from '../db';
import { AuthUser, CurrentUser } from '../common/auth';
import { notFound, Page, PageQuery } from '../common/http';
import { JobHandler, Jobs } from '../jobs/jobs';

export type Category = 'BOOKING' | 'PAYMENT' | 'DOCUMENT' | 'REFERRAL' | 'COMMISSION' | 'PAYOUT' | 'ACCOUNT' | 'GENERAL';

/** FCM. Without credentials (dev/test) it logs instead of sending. */
@Injectable()
export class Push {
  private readonly log = new Logger('push');
  private readonly messaging: Messaging | null;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.messaging = cfg.fcmCredentialsFile
      ? getMessaging(initializeApp({ credential: cert(JSON.parse(readFileSync(cfg.fcmCredentialsFile, 'utf8'))) }))
      : null;
  }

  /** Returns tokens FCM reports as dead, so the caller can delete them. */
  async send(tokens: string[], title: string, body: string, data: Record<string, string>): Promise<string[]> {
    if (!tokens.length) return [];
    if (!this.messaging) {
      this.log.debug(`push (disabled) to ${tokens.length} devices: ${title}`);
      return [];
    }
    const res = await this.messaging.sendEachForMulticast({ tokens, notification: { title, body }, data });
    return res.responses
      .map((r, i) => (r.error && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error.code) ? tokens[i] : null))
      .filter((t): t is string => t !== null);
  }
}

export interface NotificationView {
  id: string;
  category: Category;
  title: string;
  body: string;
  deepLink: string | null;
  readAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class NotificationService implements JobHandler, OnModuleInit {
  readonly type = 'PUSH';

  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly push: Push,
  ) {}

  onModuleInit() {
    this.jobs.register(this);
  }

  /** Call inside the business transaction: inbox row + push job commit together. */
  async notify(q: Queryable, userId: string, category: Category, title: string, body: string, deepLink?: string) {
    const { id } = await this.db.one<{ id: string }>(
      `insert into notification (user_id, category, title, body, deep_link) values ($1, $2, $3, $4, $5) returning id`,
      [userId, category, title, body, deepLink ?? null],
      q,
    );
    await this.jobs.enqueue(q, this.type, { id });
  }

  async notifyAdmins(q: Queryable, title: string, body: string, deepLink?: string) {
    const admins = await this.db.many<{ id: string }>(`select id from app_user where role = 'ADMIN' and active`, [], q);
    for (const a of admins) await this.notify(q, a.id, 'GENERAL', title, body, deepLink);
  }

  async handle({ id }: { id: string }) {
    const n = await this.db.maybe<NotificationView & { userId: string }>('select * from notification where id = $1', [id]);
    if (!n) return;
    const tokens = (await this.db.many<{ token: string }>('select token from device_token where user_id = $1', [n.userId])).map((t) => t.token);
    const dead = await this.push.send(tokens, n.title, n.body, { category: n.category, deepLink: n.deepLink ?? '', notificationId: n.id });
    if (dead.length) await this.db.exec('delete from device_token where token = any($1)', [dead]);
  }

  async broadcast(q: Queryable, audience: 'ALL' | 'PARTNERS', title: string, body: string) {
    const rows = await this.db.many<{ id: string }>(
      `insert into notification (user_id, category, title, body)
       select id, 'GENERAL', $2, $3 from app_user
       where active and role = 'USER' and ($1 = 'ALL' or partner_status = 'APPROVED')
       returning id`,
      [audience, title, body],
      q,
    );
    for (const r of rows) await this.jobs.enqueue(q, this.type, { id: r.id });
    return rows.length;
  }

  async list(userId: string, p: PageQuery): Promise<Page<NotificationView> & { unread: number }> {
    const items = await this.db.many<NotificationView>(
      `select id, category, title, body, deep_link, read_at, created_at from notification
       where user_id = $1 order by created_at desc limit $2 offset $3`,
      [userId, p.size, p.page * p.size],
    );
    const c = await this.db.one<{ total: number; unread: number }>(
      `select count(*) as total, count(*) filter (where read_at is null) as unread from notification where user_id = $1`,
      [userId],
    );
    return { items, page: p.page, size: p.size, ...c };
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly svc: NotificationService,
    private readonly db: Db,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() p: PageQuery) {
    return this.svc.list(u.id, p);
  }

  @Post(':id/read')
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const n = await this.db.exec(
      'update notification set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2',
      [id, u.id],
    );
    if (!n) throw notFound('Notification');
    return { ok: true };
  }

  @Post('read-all')
  async readAll(@CurrentUser() u: AuthUser) {
    await this.db.exec('update notification set read_at = now() where user_id = $1 and read_at is null', [u.id]);
    return { ok: true };
  }
}
