import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Injectable, Logger, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { IsIn, IsOptional } from 'class-validator';
import { PoolClient } from 'pg';
import { Db } from '../db';
import { AuthUser, CurrentUser } from '../common/auth';
import { notFound, PageQuery } from '../common/http';
import { LOCKS, schedulersOff, Settings, tryXactLock } from '../common/support';
import { NotificationService } from '../notify/notifications';
import { UsersService } from '../users/users';
import { commissionFor, Deductions, matchVolume, split, Upline } from './math';

export type LedgerStatus = 'PENDING' | 'ELIGIBLE' | 'APPROVED' | 'PAID' | 'ON_HOLD' | 'REVERSED';
export const LEDGER_STATUSES: LedgerStatus[] = ['PENDING', 'ELIGIBLE', 'APPROVED', 'PAID', 'ON_HOLD', 'REVERSED'];

export interface BookingForLedger {
  id: string;
  userId: string;
  internalRef: string;
  amountPaise: number;
  l1Bps: number;
  l2Bps: number;
  l3Bps: number;
}

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;

/**
 * The ONLY writer of ledger_entry / ledger_entry_status / match_*.
 * Rows are append-only (DB trigger); corrections are reversal rows.
 */
@Injectable()
export class LedgerService {
  private readonly log = new Logger('ledger');

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly notify: NotificationService,
  ) {}

  private async deductionBps(c: PoolClient) {
    return { admin: await this.settings.int('admin_bps', c), tds: await this.settings.int('tds_bps', c) };
  }

  private async insertEntry(
    c: PoolClient,
    e: { userId: string; kind: 'COMMISSION' | 'MATCHING'; level?: number; bookingId?: string; matchRunId?: string; amounts: Deductions; reversesId?: string },
    status: LedgerStatus,
    actorId: string | null = null,
    note: string | null = null,
  ) {
    const { id } = await this.db.one<{ id: string }>(
      `insert into ledger_entry (user_id, kind, level, source_booking_id, source_match_run_id, gross_paise, admin_paise, tds_paise, net_paise, reverses_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [e.userId, e.kind, e.level ?? null, e.bookingId ?? null, e.matchRunId ?? null, e.amounts.gross, e.amounts.admin, e.amounts.tds, e.amounts.net, e.reversesId ?? null],
      c,
    );
    await this.addStatus(c, id, status, actorId, note);
    return id;
  }

  private addStatus(c: PoolClient, entryId: string, status: LedgerStatus, actorId: string | null, note: string | null) {
    return this.db.exec(
      'insert into ledger_entry_status (ledger_entry_id, status, actor_id, note) values ($1, $2, $3, $4)',
      [entryId, status, actorId, note],
      c,
    );
  }

  /** Called inside the webhook transaction that confirmed the booking (C1, C3). */
  async onBookingConfirmed(c: PoolClient, b: BookingForLedger) {
    const upline = await this.db.many<Upline>(
      `with recursive up(id, sponsor_id, depth) as (
         select id, sponsor_id, 0 from app_user where id = $1
         union all select u.id, u.sponsor_id, up.depth + 1 from app_user u join up on u.id = up.sponsor_id where up.depth < 3)
       select u.id as user_id, (u.partner_status = 'APPROVED' and u.active) as approved
       from up join app_user u on u.id = up.id where up.depth between 1 and 3 order by up.depth`,
      [b.userId],
      c,
    );
    const bps = await this.deductionBps(c);
    for (const line of commissionFor(b.amountPaise, [b.l1Bps, b.l2Bps, b.l3Bps], upline, bps.admin, bps.tds)) {
      // ux_commission makes a duplicate impossible even if this ran twice.
      await this.insertEntry(c, { userId: line.userId, kind: 'COMMISSION', level: line.level, bookingId: b.id, amounts: line.amounts }, 'PENDING');
      await this.notify.notify(
        c,
        line.userId,
        'COMMISSION',
        'Commission earned',
        `Level ${line.level} commission of ${inr(line.amounts.gross)} on booking ${b.internalRef}`,
        'commission',
      );
    }
    await this.addVolume(c, b.userId, b.amountPaise);
  }

  /** Booking cancelled/refunded: reverse every derived entry and remove its volume (FR-6.4). */
  async onBookingCancelled(c: PoolClient, b: BookingForLedger, actorId: string | null) {
    const entries = await this.db.many<{ id: string; userId: string; kind: 'COMMISSION'; level: number; grossPaise: number; adminPaise: number; tdsPaise: number; netPaise: number; status: LedgerStatus; inPayout: boolean }>(
      `select v.id, v.user_id, v.kind, v.level, v.gross_paise, v.admin_paise, v.tds_paise, v.net_paise, v.status,
              exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed) as in_payout
       from ledger_view v
       where v.source_booking_id = $1 and v.reverses_id is null
         and not exists (select 1 from ledger_entry r where r.reverses_id = v.id)`,
      [b.id],
      c,
    );
    for (const e of entries) {
      const negative = { gross: -e.grossPaise, admin: -e.adminPaise, tds: -e.tdsPaise, net: -e.netPaise };
      const alreadyPaid = e.status === 'PAID' || e.inPayout;
      // Paid money is clawed back from the next payout; unpaid money is simply cancelled.
      await this.insertEntry(
        c,
        { userId: e.userId, kind: e.kind, level: e.level, bookingId: b.id, amounts: negative, reversesId: e.id },
        alreadyPaid ? 'APPROVED' : 'REVERSED',
        actorId,
        `Reversal of booking ${b.internalRef}`,
      );
      if (!alreadyPaid) await this.addStatus(c, e.id, 'REVERSED', actorId, `Booking ${b.internalRef} cancelled`);
    }
    await this.addVolume(c, b.userId, -b.amountPaise);
  }

  /** Adds booking volume to the correct leg of EVERY ancestor (matching is unlimited depth). */
  private addVolume(c: PoolClient, buyerId: string, amount: number) {
    return this.db.exec(
      `with recursive up(id, sponsor_id, leg, depth) as (
         select id, sponsor_id, leg, 0 from app_user where id = $1
         union all select u.id, u.sponsor_id, u.leg, up.depth + 1 from app_user u join up on u.id = up.sponsor_id where up.depth < 1000)
       insert into match_volume (user_id, left_paise, right_paise)
       select sponsor_id, case when leg = 'L' then $2::bigint else 0 end, case when leg = 'R' then $2::bigint else 0 end
       from up where sponsor_id is not null
       on conflict (user_id) do update set left_paise = match_volume.left_paise + excluded.left_paise,
                                           right_paise = match_volume.right_paise + excluded.right_paise`,
      [buyerId, amount],
      c,
    );
  }

  /** Admin state changes. Only transitions out of `from` are applied; returns count changed. */
  async transition(c: PoolClient, ids: string[], from: LedgerStatus[], to: LedgerStatus, actorId: string, note: string | null) {
    await c.query('select id from ledger_entry where id = any($1) order by id for update', [ids]);
    const eligible = await this.db.many<{ id: string }>(
      `select id from ledger_view v where id = any($1) and status = any($2)
       and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)`,
      [ids, from],
      c,
    );
    for (const e of eligible) await this.addStatus(c, e.id, to, actorId, note);
    return eligible.length;
  }

  async markPaid(c: PoolClient, payoutId: string) {
    const items = await this.db.many<{ ledgerEntryId: string }>('select ledger_entry_id from payout_item where payout_id = $1 and not failed', [payoutId], c);
    for (const i of items) await this.addStatus(c, i.ledgerEntryId, 'PAID', null, `Payout ${payoutId}`);
  }

  /** A paid payout was reversed by the bank: money is owed again. */
  async reopenAfterPayoutReversal(c: PoolClient, payoutId: string) {
    const items = await this.db.many<{ ledgerEntryId: string }>('select ledger_entry_id from payout_item where payout_id = $1', [payoutId], c);
    for (const i of items) await this.addStatus(c, i.ledgerEntryId, 'APPROVED', null, `Payout ${payoutId} reversed`);
  }

  /** PENDING → ELIGIBLE after the cooling period, while the source booking is still confirmed. */
  @Interval(10 * 60 * 1000)
  async promoteEligible(force = false) {
    if (!force && schedulersOff()) return;
    await this.db.tx(async (c) => {
      if (!(await tryXactLock(c, LOCKS.eligibility))) return;
      const days = await this.settings.int('cooling_days', c);
      const rows = await this.db.many<{ id: string }>(
        `select v.id from ledger_view v left join booking b on b.id = v.source_booking_id
         where v.status = 'PENDING' and v.reverses_id is null
           and v.created_at < now() - make_interval(days => $1)
           and (v.kind = 'MATCHING' or b.status = 'CONFIRMED')`,
        [days],
        c,
      );
      for (const r of rows) await this.addStatus(c, r.id, 'ELIGIBLE', null, 'Cooling period complete');
      if (rows.length) this.log.log(`${rows.length} entries now eligible`);
    });
  }

  /** Daily 70:30 matching run (01:30 IST). */
  @Cron('0 30 1 * * *', { timeZone: 'Asia/Kolkata' })
  async runMatching(force = false) {
    if (!force && schedulersOff()) return;
    await this.db.tx(async (c) => {
      if (!(await tryXactLock(c, LOCKS.matching))) return;
      const power = await this.settings.int('matching_power_pct', c);
      const weak = await this.settings.int('matching_weak_pct', c);
      const bonusBps = await this.settings.int('matching_bonus_bps', c);
      const bps = await this.deductionBps(c);
      const rows = await this.db.many<{ userId: string; availLeft: number; availRight: number }>(
        `select m.user_id, m.left_paise - m.left_used as avail_left, m.right_paise - m.right_used as avail_right
         from match_volume m join app_user u on u.id = m.user_id
         where u.partner_status = 'APPROVED' and u.active
           and m.left_paise > m.left_used and m.right_paise > m.right_used
         for update of m`,
        [],
        c,
      );
      for (const r of rows) {
        const m = matchVolume(r.availLeft, r.availRight, power, weak, bonusBps);
        if (!m || m.bonus <= 0) continue;
        const { id: runId } = await this.db.one<{ id: string }>(
          `insert into match_run (user_id, left_used, right_used, matched_paise, bonus_paise) values ($1, $2, $3, $4, $5) returning id`,
          [r.userId, m.usedLeft, m.usedRight, m.matched, m.bonus],
          c,
        );
        await c.query('update match_volume set left_used = left_used + $2, right_used = right_used + $3 where user_id = $1', [r.userId, m.usedLeft, m.usedRight]);
        await this.insertEntry(c, { userId: r.userId, kind: 'MATCHING', matchRunId: runId, amounts: split(m.bonus, bps.admin, bps.tds) }, 'PENDING');
        await this.notify.notify(c, r.userId, 'COMMISSION', 'Matching bonus', `Matching bonus of ${inr(m.bonus)} credited`, 'matching');
      }
      this.log.log(`matching run processed ${rows.length} partners`);
    });
  }
}

// ---------- User-facing earnings (A09–A12) ----------

export class LedgerQuery extends PageQuery {
  @IsOptional() @IsIn(LEDGER_STATUSES) status?: LedgerStatus;
  @IsOptional() @IsIn(['COMMISSION', 'MATCHING']) kind?: 'COMMISSION' | 'MATCHING';
}

@ApiTags('Earnings')
@ApiBearerAuth()
@Controller()
export class EarningsController {
  constructor(
    private readonly db: Db,
    private readonly users: UsersService,
  ) {}

  private summary(userId: string, kind: string) {
    return this.db.many(
      `select status, count(*) as count, coalesce(sum(gross_paise), 0) as gross_paise, coalesce(sum(admin_paise), 0) as admin_paise,
              coalesce(sum(tds_paise), 0) as tds_paise, coalesce(sum(net_paise), 0) as net_paise
       from ledger_view where user_id = $1 and kind = $2 group by status`,
      [userId, kind],
    );
  }

  @Get('commissions/summary')
  async commissionSummary(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    return { byStatus: await this.summary(u.id, 'COMMISSION') };
  }

  @Get('commissions')
  async list(@CurrentUser() u: AuthUser, @Query() q: LedgerQuery) {
    await this.users.requirePartner(u.id);
    const params = [u.id, q.status ?? null, q.kind ?? 'COMMISSION'];
    const where = `from ledger_view v where v.user_id = $1 and ($2::text is null or v.status = $2) and v.kind = $3`;
    const items = await this.db.many(
      `select v.id, v.kind, v.level, v.gross_paise, v.admin_paise, v.tds_paise, v.net_paise, v.status, v.status_at,
              v.reverses_id, v.created_at, b.internal_ref as booking_ref, p.plot_no, t.name as tier_name
       ${where.replace('from ledger_view v', 'from ledger_view v left join booking b on b.id = v.source_booking_id left join plot p on p.id = b.plot_id left join tier t on t.id = b.tier_id')}
       order by v.created_at desc limit $4 offset $5`,
      [...params, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>(`select count(*) as total ${where}`, params);
    return { items, page: q.page, size: q.size, total };
  }

  /** A10: gross, each deduction and net shown separately (PDF §6), plus status history. */
  @Get('commissions/:id')
  async detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const e = await this.db.maybe(
      `select v.*, b.internal_ref as booking_ref, p.plot_no, t.name as tier_name, buyer.name as buyer_name
       from ledger_view v
       left join booking b on b.id = v.source_booking_id left join plot p on p.id = b.plot_id
       left join tier t on t.id = b.tier_id left join app_user buyer on buyer.id = b.user_id
       where v.id = $1 and v.user_id = $2`,
      [id, u.id],
    );
    if (!e) throw notFound('Ledger entry');
    const history = await this.db.many('select status, note, created_at from ledger_entry_status where ledger_entry_id = $1 order by id', [id]);
    return { ...e, history };
  }

  /** A11: left/right volumes and carry-forward. */
  @Get('matching/summary')
  async matching(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const v = (await this.db.maybe<{ leftPaise: number; rightPaise: number; leftUsed: number; rightUsed: number }>(
      'select left_paise, right_paise, left_used, right_used from match_volume where user_id = $1',
      [u.id],
    )) ?? { leftPaise: 0, rightPaise: 0, leftUsed: 0, rightUsed: 0 };
    return {
      leftVolumePaise: v.leftPaise,
      rightVolumePaise: v.rightPaise,
      carryLeftPaise: v.leftPaise - v.leftUsed,
      carryRightPaise: v.rightPaise - v.rightUsed,
      powerLeg: v.leftPaise >= v.rightPaise ? 'L' : 'R',
      byStatus: await this.summary(u.id, 'MATCHING'),
    };
  }

  @Get('matching/runs')
  async runs(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    await this.users.requirePartner(u.id);
    const items = await this.db.many(
      'select * from match_run where user_id = $1 order by created_at desc limit $2 offset $3',
      [u.id, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from match_run where user_id = $1', [u.id]);
    return { items, page: q.page, size: q.size, total };
  }
}

