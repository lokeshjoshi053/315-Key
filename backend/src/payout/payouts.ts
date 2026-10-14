import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Logger, Post, Put, Query, RawBodyRequest, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Request } from 'express';
import { PoolClient } from 'pg';
import { CONFIG, Config } from '../config';
import { Db } from '../db';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { badRequest, PageQuery, providerError, unauthorized } from '../common/http';
import { Crypto, hmac, Refs, safeEqual, Settings } from '../common/support';
import { LedgerService } from '../ledger/ledger';
import { NotificationService } from '../notify/notifications';
import { UsersService } from '../users/users';

export interface PayoutEvent {
  eventId: string;
  transferId: string; // our payout internal_ref
  type: 'SUCCESS' | 'FAILED' | 'REVERSED';
  reason?: string;
}

/** Vendor edge (C7). Abstract class is the DI token; tests swap a fake. */
export abstract class PayoutGateway {
  abstract addBeneficiary(b: { beneId: string; name: string; account: string; ifsc: string; phone?: string | null; email?: string | null }): Promise<void>;
  abstract transfer(transferId: string, beneId: string, amountPaise: number): Promise<string>;
  abstract verifyWebhook(raw: Buffer, signature: string, timestamp: string): boolean;
  abstract parseWebhook(raw: Buffer): PayoutEvent | null;
}

/**
 * Cashfree Payouts v2. VERIFY every path, header and field against current Cashfree docs
 * (API version, beneficiary/transfer shapes, webhook signature = base64 HMAC-SHA256(timestamp + raw body)).
 */
@Injectable()
export class CashfreeGateway extends PayoutGateway {
  constructor(@Inject(CONFIG) private readonly cfg: Config) {
    super();
  }

  private async call(path: string, body: unknown) {
    const res = await fetch(this.cfg.cashfree.baseUrl + path, {
      method: 'POST',
      headers: {
        'x-client-id': this.cfg.cashfree.clientId,
        'x-client-secret': this.cfg.cashfree.clientSecret,
        'x-api-version': '2024-01-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw providerError(`Payout provider error: ${json?.message ?? res.status}`);
    return json;
  }

  async addBeneficiary(b: { beneId: string; name: string; account: string; ifsc: string; phone?: string | null; email?: string | null }) {
    await this.call('/beneficiary', {
      beneficiary_id: b.beneId,
      beneficiary_name: b.name,
      beneficiary_instrument_details: { bank_account_number: b.account, bank_ifsc: b.ifsc },
      beneficiary_contact_details: { beneficiary_phone: b.phone ?? undefined, beneficiary_email: b.email ?? undefined },
    });
  }

  async transfer(transferId: string, beneId: string, amountPaise: number) {
    const r = await this.call('/transfers', {
      transfer_id: transferId,
      transfer_amount: amountPaise / 100,
      transfer_mode: 'banktransfer',
      beneficiary_details: { beneficiary_id: beneId },
    });
    return String(r.cf_transfer_id ?? transferId);
  }

  verifyWebhook(raw: Buffer, signature: string, timestamp: string) {
    if (!signature || !timestamp) return false;
    return safeEqual(hmac(this.cfg.cashfree.clientSecret, timestamp + raw.toString('utf8'), 'base64'), signature);
  }

  parseWebhook(raw: Buffer): PayoutEvent | null {
    const b = JSON.parse(raw.toString('utf8'));
    const map: Record<string, PayoutEvent['type']> = { TRANSFER_SUCCESS: 'SUCCESS', TRANSFER_FAILED: 'FAILED', TRANSFER_REJECTED: 'FAILED', TRANSFER_REVERSED: 'REVERSED' };
    const type = map[b.type];
    if (!type) return null;
    const transferId = b.data?.transfer_id;
    return { eventId: `${transferId}:${b.type}`, transferId, type, reason: b.data?.status_description };
  }
}

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;

@Injectable()
export class PayoutService {
  private readonly log = new Logger('payout');

  constructor(
    private readonly db: Db,
    private readonly gateway: PayoutGateway,
    private readonly crypto: Crypto,
    private readonly users: UsersService,
    private readonly refs: Refs,
    private readonly settings: Settings,
    private readonly ledger: LedgerService,
    private readonly notify: NotificationService,
  ) {}

  async setBeneficiary(userId: string, dto: BeneficiaryDto) {
    const user = await this.users.requirePartner(userId);
    const beneId = `U${userId.replace(/-/g, '')}`.slice(0, 50);
    // ponytail: a changed bank account re-registers under the same bene id. VERIFY Cashfree allows update-by-recreate.
    await this.gateway.addBeneficiary({ beneId, name: dto.holderName, account: dto.accountNumber, ifsc: dto.ifsc, phone: user.mobile, email: user.email });
    await this.db.exec(
      `insert into beneficiary (user_id, holder_name, account_enc, account_last4, ifsc, pan_enc, pan_last4, provider_bene_id, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'VERIFIED')
       on conflict (user_id) do update set holder_name = excluded.holder_name, account_enc = excluded.account_enc,
         account_last4 = excluded.account_last4, ifsc = excluded.ifsc, pan_enc = excluded.pan_enc, pan_last4 = excluded.pan_last4,
         provider_bene_id = excluded.provider_bene_id, status = 'VERIFIED', updated_at = now()`,
      [userId, dto.holderName, this.crypto.encrypt(dto.accountNumber), dto.accountNumber.slice(-4), dto.ifsc, this.crypto.encrypt(dto.pan), dto.pan.slice(-4), beneId],
    );
    return this.getBeneficiary(userId);
  }

  getBeneficiary(userId: string) {
    return this.db.maybe(
      `select holder_name, '****' || account_last4 as account_masked, ifsc, '******' || pan_last4 as pan_masked, status, updated_at
       from beneficiary where user_id = $1`,
      [userId],
    );
  }

  /**
   * Admin batch: one payout per user from APPROVED net entries not already in a live payout.
   * Ledger rows are locked/claimed in a transaction; the bank transfer happens after commit.
   */
  async createBatch(actorId: string, userIds?: string[]) {
    const min = await this.settings.int('min_payout_paise');
    const candidates = await this.db.many<{ userId: string }>(
      `select v.user_id from ledger_view v join beneficiary bn on bn.user_id = v.user_id and bn.status = 'VERIFIED'
       where v.status = 'APPROVED' and ($1::uuid[] is null or v.user_id = any($1))
         and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)
       group by v.user_id having sum(v.net_paise) >= $2`,
      [userIds?.length ? userIds : null, min],
    );
    const results: { userId: string; payoutRef?: string; amountPaise?: number; status: string; error?: string }[] = [];
    for (const { userId } of candidates) {
      const claimed = await this.db.tx(async (c) => {
        const bene = await this.db.one<{ providerBeneId: string }>('select provider_bene_id from beneficiary where user_id = $1 for update', [userId], c);
        const entries = await this.db.many<{ id: string; netPaise: number }>(
          `select v.id, v.net_paise from ledger_view v where v.user_id = $1 and v.status = 'APPROVED'
           and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)`,
          [userId],
          c,
        );
        const amount = entries.reduce((s, e) => s + e.netPaise, 0);
        if (amount < min) return null;
        const ref = await this.refs.next('PO', c);
        const { id } = await this.db.one<{ id: string }>(
          `insert into payout (internal_ref, user_id, amount_paise, status, created_by) values ($1, $2, $3, 'REQUESTED', $4) returning id`,
          [ref, userId, amount, actorId],
          c,
        );
        for (const e of entries) await c.query('insert into payout_item (payout_id, ledger_entry_id) values ($1, $2)', [id, e.id]);
        return { id, ref, amount, beneId: bene.providerBeneId };
      });
      if (!claimed) continue;
      try {
        const transferId = await this.gateway.transfer(claimed.ref, claimed.beneId, claimed.amount);
        await this.db.exec(`update payout set status = 'PROCESSING', provider_transfer_id = $2, updated_at = now() where id = $1 and status = 'REQUESTED'`, [claimed.id, transferId]);
        results.push({ userId, payoutRef: claimed.ref, amountPaise: claimed.amount, status: 'PROCESSING' });
      } catch (e) {
        await this.fail(claimed.ref, String((e as Error).message));
        results.push({ userId, payoutRef: claimed.ref, amountPaise: claimed.amount, status: 'FAILED', error: String((e as Error).message) });
      }
    }
    return { created: results.length, results };
  }

  private fail(ref: string, reason: string) {
    return this.db.tx((c) => this.failIn(c, ref, reason));
  }

  private async failIn(c: PoolClient, ref: string, reason: string) {
    const p = await this.db.maybe<{ id: string; userId: string; status: string }>('select id, user_id, status from payout where internal_ref = $1 for update', [ref], c);
    if (!p || p.status === 'FAILED') return;
    if (p.status === 'PAID') await this.ledger.reopenAfterPayoutReversal(c, p.id);
    await c.query(`update payout set status = 'FAILED', failure_reason = $2, updated_at = now() where id = $1`, [p.id, reason.slice(0, 500)]);
    await c.query('update payout_item set failed = true where payout_id = $1', [p.id]);
    await this.notify.notify(c, p.userId, 'PAYOUT', 'Payout failed', 'Your payout could not be completed. Check your bank details.', `payout/${p.id}`);
  }

  /** Dedupe + effect in one transaction (C3). */
  async onWebhook(e: PayoutEvent, raw: string) {
    await this.db.tx(async (c) => {
      const fresh = await this.db.exec(
        `insert into webhook_event (provider, provider_event_id, payload) values ('cashfree', $1, $2::jsonb) on conflict do nothing`,
        [e.eventId, raw],
        c,
      );
      if (!fresh) return;
      if (e.type !== 'SUCCESS') return this.failIn(c, e.transferId, e.reason ?? e.type);
      const p = await this.db.maybe<{ id: string; userId: string; status: string; amountPaise: number }>(
        'select id, user_id, status, amount_paise from payout where internal_ref = $1 for update',
        [e.transferId],
        c,
      );
      if (!p || p.status === 'PAID' || p.status === 'FAILED') return;
      await c.query(`update payout set status = 'PAID', updated_at = now() where id = $1`, [p.id]);
      await this.ledger.markPaid(c, p.id);
      await this.notify.notify(c, p.userId, 'PAYOUT', 'Payout sent', `${inr(p.amountPaise)} has been paid to your bank account`, `payout/${p.id}`);
    });
  }
}

export class BeneficiaryDto {
  @IsString() @IsNotEmpty() @MaxLength(100) holderName: string;
  @Matches(/^\d{9,18}$/, { message: 'accountNumber must be 9–18 digits' }) accountNumber: string;
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'ifsc is invalid' }) ifsc: string;
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'pan is invalid' }) pan: string; // required for TDS (risk #2)
}

@ApiTags('Payouts')
@ApiBearerAuth()
@Controller('payouts')
export class PayoutController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly db: Db,
    private readonly users: UsersService,
  ) {}

  @Get('beneficiary')
  async bene(@CurrentUser() u: AuthUser) {
    return (await this.payouts.getBeneficiary(u.id)) ?? {};
  }

  @Put('beneficiary')
  setBene(@CurrentUser() u: AuthUser, @Body() dto: BeneficiaryDto) {
    if (dto.accountNumber === dto.pan) throw badRequest('INVALID', 'Invalid details');
    return this.payouts.setBeneficiary(u.id, dto);
  }

  /** A13 */
  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    await this.users.requirePartner(u.id);
    const items = await this.db.many(
      `select id, internal_ref, amount_paise, status, provider_transfer_id, failure_reason, created_at, updated_at
       from payout where user_id = $1 order by created_at desc limit $2 offset $3`,
      [u.id, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from payout where user_id = $1', [u.id]);
    const { available } = await this.db.one<{ available: number }>(
      `select coalesce(sum(net_paise), 0) as available from ledger_view v where v.user_id = $1 and v.status = 'APPROVED'
       and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)`,
      [u.id],
    );
    return { items, page: q.page, size: q.size, total, availablePaise: available };
  }
}

@Public()
@SkipThrottle()
@ApiTags('Webhooks')
@Controller('webhooks')
export class PayoutWebhookController {
  private readonly log = new Logger('webhook');

  constructor(
    private readonly payouts: PayoutService,
    private readonly gateway: PayoutGateway,
  ) {}

  @Post('cashfree')
  @HttpCode(200)
  async cashfree(@Req() req: RawBodyRequest<Request>, @Headers('x-webhook-signature') sig: string, @Headers('x-webhook-timestamp') ts: string) {
    const raw = req.rawBody;
    if (!raw || !this.gateway.verifyWebhook(raw, sig, ts)) {
      this.log.warn('cashfree webhook signature rejected');
      throw unauthorized('SIGNATURE_INVALID', 'Invalid signature');
    }
    const e = this.gateway.parseWebhook(raw);
    if (e) await this.payouts.onWebhook(e, raw.toString('utf8'));
    return { ok: true };
  }
}
