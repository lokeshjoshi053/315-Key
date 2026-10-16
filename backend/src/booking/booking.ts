import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Injectable, Logger, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Equals, IsBoolean, IsUUID } from 'class-validator';
import { PoolClient } from 'pg';
import { Db } from '../db';
import { AuthUser, CurrentUser } from '../common/auth';
import { badRequest, conflict, notFound, PageQuery, providerError, unavailable } from '../common/http';
import { LOCKS, Refs, schedulersOff, Settings, tryXactLock } from '../common/support';
import { Jobs } from '../jobs/jobs';
import { BookingForLedger, LedgerService } from '../ledger/ledger';
import { NotificationService } from '../notify/notifications';
import { PaymentGateway } from '../payment/gateway';
import { UsersService } from '../users/users';

export type BookingStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED';

export interface BookingRow extends BookingForLedger {
  plotId: string;
  tierId: string;
  status: BookingStatus;
  holdExpiresAt: Date;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface Checkout {
  bookingId: string;
  bookingRef: string;
  paymentId: string;
  paymentRef: string;
  amountPaise: number;
  currency: 'INR';
  razorpayOrderId: string;
  razorpayKeyId: string;
  holdExpiresAt: Date;
}

export class CreateBookingDto {
  @IsUUID() plotId: string;
  @IsUUID() tierId: string;
  @IsBoolean() @Equals(true, { message: 'terms must be accepted' }) termsAccepted: boolean;
}

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`;

@Injectable()
export class BookingService {
  private readonly log = new Logger('booking');

  constructor(
    private readonly db: Db,
    private readonly refs: Refs,
    private readonly settings: Settings,
    private readonly users: UsersService,
    private readonly gateway: PaymentGateway,
    private readonly ledger: LedgerService,
    private readonly notify: NotificationService,
    private readonly jobs: Jobs,
  ) {}

  /**
   * C08 → C09. Holds the plot under a row lock, then creates the provider order
   * AFTER commit so the lock is never held across an HTTP call.
   */
  async create(userId: string, dto: CreateBookingDto): Promise<Checkout> {
    const user = await this.users.get(userId);
    if (!user.name) throw badRequest('PROFILE_INCOMPLETE', 'Complete your profile before booking');
    if (!(await this.settings.bool('bookings_enabled'))) throw unavailable('BOOKINGS_PAUSED', 'Bookings are paused, try later');

    const held = await this.db.tx(async (c) => {
      // A lapsed checkout of this user's is expired here, so nobody waits on the hold-expiry job.
      const lapsed = await this.db.many<{ plotId: string }>(
        `update booking set status = 'EXPIRED', updated_at = now()
         where user_id = $1 and status = 'PENDING_PAYMENT' and hold_expires_at < now() returning plot_id`,
        [userId],
        c,
      );
      if (lapsed.length) {
        await c.query(`update plot set status = 'AVAILABLE', held_until = null, updated_at = now() where id = any($1) and status = 'HELD' and held_until < now()`, [lapsed.map((l) => l.plotId)]);
      }
      const pending = await this.db.maybe('select 1 from booking where user_id = $1 and status = $2', [userId, 'PENDING_PAYMENT'], c);
      if (pending) throw conflict('PENDING_BOOKING_EXISTS', 'Finish or cancel your current checkout first');

      const plot = await this.db.maybe<{ status: string; heldUntil: Date | null }>('select status, held_until from plot where id = $1 for update', [dto.plotId], c);
      if (!plot) throw notFound('Plot');
      const lapsedHold = plot.status === 'HELD' && plot.heldUntil! < new Date();
      if (plot.status !== 'AVAILABLE' && !lapsedHold) throw conflict('PLOT_UNAVAILABLE', 'This plot is no longer available');
      if (lapsedHold) await c.query(`update booking set status = 'EXPIRED', updated_at = now() where plot_id = $1 and status = 'PENDING_PAYMENT'`, [dto.plotId]);

      const tier = await this.db.maybe<{ amountPaise: number; l1Bps: number; l2Bps: number; l3Bps: number }>(
        'select amount_paise, l1_bps, l2_bps, l3_bps from tier where id = $1 and active',
        [dto.tierId],
        c,
      );
      if (!tier) throw notFound('Plan');

      const holdMin = await this.settings.int('hold_minutes', c);
      const { holdExpiresAt } = await this.db.one<{ holdExpiresAt: Date }>(
        `update plot set status = 'HELD', held_until = now() + make_interval(mins => $2), updated_at = now() where id = $1 returning held_until as hold_expires_at`,
        [dto.plotId, holdMin],
        c,
      );
      const bookingRef = await this.refs.next('BK', c);
      const { id: bookingId } = await this.db.one<{ id: string }>(
        `insert into booking (internal_ref, user_id, plot_id, tier_id, amount_paise, l1_bps, l2_bps, l3_bps, status, hold_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_PAYMENT', $9) returning id`,
        [bookingRef, userId, dto.plotId, dto.tierId, tier.amountPaise, tier.l1Bps, tier.l2Bps, tier.l3Bps, holdExpiresAt],
        c,
      );
      const payment = await this.newPayment(c, bookingId, userId, tier.amountPaise);
      return { bookingId, bookingRef, holdExpiresAt, amountPaise: tier.amountPaise, ...payment };
    });

    const razorpayOrderId = await this.openOrder(held.paymentId, held.paymentRef, held.amountPaise);
    return { ...held, currency: 'INR', razorpayOrderId, razorpayKeyId: this.gateway.publicKey };
  }

  /** C09 "retry": new provider order while the hold is still live. */
  async retryPayment(userId: string, bookingId: string): Promise<Checkout> {
    const r = await this.db.tx(async (c) => {
      const b = await this.db.maybe<BookingRow>('select * from booking where id = $1 and user_id = $2 for update', [bookingId, userId], c);
      if (!b) throw notFound('Booking');
      if (b.status !== 'PENDING_PAYMENT' || b.holdExpiresAt < new Date()) throw conflict('HOLD_EXPIRED', 'This booking can no longer be paid, start a new one');
      await c.query(`update payment set status = 'FAILED', failure_reason = 'SUPERSEDED', updated_at = now() where booking_id = $1 and status in ('CREATED', 'PENDING')`, [b.id]);
      return { b, ...(await this.newPayment(c, b.id, userId, b.amountPaise)) };
    });
    const razorpayOrderId = await this.openOrder(r.paymentId, r.paymentRef, r.b.amountPaise);
    return {
      bookingId: r.b.id,
      bookingRef: r.b.internalRef,
      paymentId: r.paymentId,
      paymentRef: r.paymentRef,
      amountPaise: r.b.amountPaise,
      currency: 'INR',
      razorpayOrderId,
      razorpayKeyId: this.gateway.publicKey,
      holdExpiresAt: r.b.holdExpiresAt,
    };
  }

  private async newPayment(c: PoolClient, bookingId: string, userId: string, amountPaise: number) {
    const paymentRef = await this.refs.next('PAY', c);
    const { id: paymentId } = await this.db.one<{ id: string }>(
      `insert into payment (internal_ref, booking_id, user_id, amount_paise, status) values ($1, $2, $3, $4, 'CREATED') returning id`,
      [paymentRef, bookingId, userId, amountPaise],
      c,
    );
    return { paymentId, paymentRef };
  }

  private async openOrder(paymentId: string, receipt: string, amountPaise: number) {
    try {
      const { providerOrderId } = await this.gateway.createOrder(receipt, amountPaise);
      await this.db.exec(`update payment set provider_order_id = $2, status = 'PENDING', updated_at = now() where id = $1`, [paymentId, providerOrderId]);
      return providerOrderId;
    } catch (e) {
      this.log.error(`createOrder failed for ${receipt}: ${e}`);
      await this.db.exec(`update payment set status = 'FAILED', failure_reason = 'ORDER_CREATE_FAILED', updated_at = now() where id = $1`, [paymentId]);
      throw providerError('Could not start payment, please retry');
    }
  }

  /**
   * Runs inside the verified-webhook transaction (payment row already locked + VERIFIED).
   * Either confirms the booking, or, if the plot was lost after the hold lapsed, queues a refund (FR-4.6).
   */
  async onPaymentVerified(c: PoolClient, paymentId: string, bookingId: string) {
    const b = await this.db.one<BookingRow>('select * from booking where id = $1 for update', [bookingId], c);
    const plot = await this.db.one<{ status: string; plotNo: string }>('select status, plot_no from plot where id = $1 for update', [b.plotId], c);
    const canConfirm = b.status === 'PENDING_PAYMENT' || (b.status === 'EXPIRED' && plot.status === 'AVAILABLE');

    if (canConfirm) {
      await c.query(`update booking set status = 'CONFIRMED', confirmed_at = now(), updated_at = now() where id = $1`, [b.id]);
      await c.query(`update plot set status = 'BOOKED', held_until = null, updated_at = now() where id = $1`, [b.plotId]);
      await this.ledger.onBookingConfirmed(c, b);
      await this.notify.notify(c, b.userId, 'BOOKING', 'Booking confirmed', `Plot ${plot.plotNo} is booked. Ref ${b.internalRef}`, `booking/${b.id}`);
      return;
    }

    // Money taken but booking can't stand: refund this payment.
    await c.query(`update payment set status = 'REFUND_PENDING', updated_at = now() where id = $1`, [paymentId]);
    if (b.status !== 'CONFIRMED') await c.query(`update booking set status = 'REFUND_PENDING', updated_at = now() where id = $1`, [b.id]);
    await this.jobs.enqueue(c, 'REFUND', { paymentId });
    await this.notify.notify(c, b.userId, 'PAYMENT', 'Payment will be refunded', `Plot ${plot.plotNo} was no longer available. Your payment of ${inr(b.amountPaise)} will be refunded.`, `payment/${paymentId}`);
    await this.notify.notifyAdmins(c, 'Auto-refund queued', `Late payment on ${b.internalRef}; refund queued`, `booking/${b.id}`);
    this.log.warn(`late capture on ${b.internalRef}: refund queued`);
  }

  /** Admin cancel of a confirmed booking: frees plot, reverses ledger, optionally refunds. */
  async cancel(c: PoolClient, bookingId: string, actorId: string, refund: boolean) {
    const b = await this.db.maybe<BookingRow>('select * from booking where id = $1 for update', [bookingId], c);
    if (!b) throw notFound('Booking');
    if (b.status !== 'CONFIRMED' && b.status !== 'PENDING_PAYMENT') throw conflict('INVALID_STATE', `Booking is ${b.status}`);
    await c.query(`update booking set status = $2, updated_at = now() where id = $1`, [b.id, refund && b.status === 'CONFIRMED' ? 'REFUND_PENDING' : 'CANCELLED']);
    await c.query(`update plot set status = 'AVAILABLE', held_until = null, updated_at = now() where id = $1 and status in ('HELD', 'BOOKED')`, [b.plotId]);
    if (b.status === 'CONFIRMED') {
      await this.ledger.onBookingCancelled(c, b, actorId);
      if (refund) {
        const paid = await this.db.many<{ id: string }>(`select id from payment where booking_id = $1 and status = 'VERIFIED'`, [b.id], c);
        for (const p of paid) {
          await c.query(`update payment set status = 'REFUND_PENDING', updated_at = now() where id = $1`, [p.id]);
          await this.jobs.enqueue(c, 'REFUND', { paymentId: p.id });
        }
      }
    }
    await this.notify.notify(c, b.userId, 'BOOKING', 'Booking cancelled', `Booking ${b.internalRef} was cancelled${refund ? '; refund initiated' : ''}.`, `booking/${b.id}`);
    return b;
  }

  /** Lapsed holds free their plots (AC-7: within 1 minute). */
  @Interval(30_000)
  async expireHolds(force = false) {
    if (!force && schedulersOff()) return;
    await this.db.tx(async (c) => {
      if (!(await tryXactLock(c, LOCKS.holdExpiry))) return;
      const expired = await this.db.many<{ plotId: string }>(
        `update booking set status = 'EXPIRED', updated_at = now()
         where status = 'PENDING_PAYMENT' and hold_expires_at < now() returning plot_id`,
        [],
        c,
      );
      if (!expired.length) return;
      await c.query(`update plot set status = 'AVAILABLE', held_until = null, updated_at = now() where id = any($1) and status = 'HELD'`, [expired.map((e) => e.plotId)]);
      this.log.log(`expired ${expired.length} holds`);
    });
  }
}

export const BOOKING_VIEW = `
  select b.id, b.internal_ref, b.status, b.amount_paise, b.hold_expires_at, b.confirmed_at, b.created_at,
         json_build_object('id', p.id, 'plotNo', p.plot_no, 'block', p.block, 'facing', p.facing, 'areaSqft', p.area_sqft, 'lat', p.lat, 'lng', p.lng) as plot,
         json_build_object('id', t.id, 'code', t.code, 'name', t.name) as tier
  from booking b join plot p on p.id = b.plot_id join tier t on t.id = b.tier_id`;

@ApiTags('Bookings')
@ApiBearerAuth()
@Controller('bookings')
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly db: Db,
  ) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create(u.id, dto);
  }

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    const items = await this.db.many(`${BOOKING_VIEW} where b.user_id = $1 order by b.created_at desc limit $2 offset $3`, [u.id, q.size, q.page * q.size]);
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from booking where user_id = $1', [u.id]);
    return { items, page: q.page, size: q.size, total };
  }

  /** C11: single view of the booking lifecycle. */
  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const b = await this.db.maybe(`${BOOKING_VIEW} where b.id = $1 and b.user_id = $2`, [id, u.id]);
    if (!b) throw notFound('Booking');
    const payments = await this.db.many(
      `select id, internal_ref, amount_paise, status, provider_order_id, provider_payment_id, failure_reason, verified_at, created_at
       from payment where booking_id = $1 order by created_at desc`,
      [id],
    );
    const documents = await this.db.many('select id, type, title, status, created_at from document where booking_id = $1 order by created_at', [id]);
    return { ...b, payments, documents };
  }

  @Post(':id/retry-payment')
  retry(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookings.retryPayment(u.id, id);
  }
}
