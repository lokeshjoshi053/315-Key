import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Headers, HttpCode, Injectable, Logger, OnModuleInit, Param, ParseUUIDPipe, Post, Query, RawBodyRequest, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { Db } from '../db';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { badRequest, notFound, PageQuery, unauthorized } from '../common/http';
import { sha256 } from '../common/support';
import { JobHandler, Jobs } from '../jobs/jobs';
import { BookingService } from '../booking/booking';
import { NotificationService } from '../notify/notifications';
import { PaymentEvent, PaymentGateway } from './gateway';

interface PaymentRow {
  id: string;
  internalRef: string;
  bookingId: string;
  userId: string;
  amountPaise: number;
  status: 'CREATED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED';
  providerPaymentId: string | null;
  providerRefundId: string | null;
}

@Injectable()
export class PaymentService implements JobHandler, OnModuleInit {
  readonly type = 'REFUND';
  private readonly log = new Logger('payment');

  constructor(
    private readonly db: Db,
    private readonly gateway: PaymentGateway,
    private readonly bookings: BookingService,
    private readonly notify: NotificationService,
    private readonly jobs: Jobs,
  ) {}

  onModuleInit() {
    this.jobs.register(this);
  }

  /**
   * The single entry point for provider truth (webhook or server-side fetch).
   * Dedupe insert + state change + ledger + jobs commit atomically, so a duplicate
   * or a crash mid-way can never produce a second booking or ledger row (AC-2, AC-3).
   */
  async apply(e: PaymentEvent, rawPayload?: string) {
    await this.db.tx(async (c) => {
      const fresh = await this.db.exec(
        `insert into webhook_event (provider, provider_event_id, payload) values ('razorpay', $1, $2::jsonb) on conflict do nothing`,
        [e.providerEventId, rawPayload ?? JSON.stringify(e)],
        c,
      );
      if (!fresh) return;

      if (e.type === 'REFUNDED') {
        const p = await this.db.maybe<PaymentRow>('select * from payment where provider_payment_id = $1 for update', [e.providerPaymentId], c);
        if (!p || p.status === 'REFUNDED') return;
        await c.query(`update payment set status = 'REFUNDED', updated_at = now() where id = $1`, [p.id]);
        await c.query(`update booking set status = 'REFUNDED', updated_at = now() where id = $1 and status = 'REFUND_PENDING'`, [p.bookingId]);
        await this.notify.notify(c, p.userId, 'PAYMENT', 'Refund processed', `Refund for ${p.internalRef} has been processed`, `payment/${p.id}`);
        return;
      }

      const p = await this.db.maybe<PaymentRow>('select * from payment where provider_order_id = $1 for update', [e.providerOrderId], c);
      if (!p) {
        this.log.warn(`event ${e.providerEventId} for unknown order ${e.providerOrderId}`);
        return;
      }
      if (p.status === 'VERIFIED' || p.status === 'REFUND_PENDING' || p.status === 'REFUNDED') return;

      if (e.type === 'FAILED') {
        await c.query(`update payment set status = 'FAILED', provider_payment_id = coalesce(provider_payment_id, $2), failure_reason = $3, updated_at = now() where id = $1`, [p.id, e.providerPaymentId, e.reason ?? 'FAILED']);
        await this.notify.notify(c, p.userId, 'PAYMENT', 'Payment failed', 'Your payment did not go through. You can retry while your plot is held.', `booking/${p.bookingId}`);
        return;
      }

      if (e.amountPaise !== p.amountPaise) {
        await c.query(`update payment set status = 'FAILED', provider_payment_id = $2, failure_reason = 'AMOUNT_MISMATCH', updated_at = now() where id = $1`, [p.id, e.providerPaymentId]);
        await this.notify.notifyAdmins(c, 'Payment amount mismatch', `${p.internalRef}: expected ${p.amountPaise}, got ${e.amountPaise}`, `payment/${p.id}`);
        this.log.error(`AMOUNT_MISMATCH on ${p.internalRef}`);
        return;
      }

      await c.query(`update payment set status = 'VERIFIED', provider_payment_id = $2, verified_at = now(), updated_at = now() where id = $1`, [p.id, e.providerPaymentId]);
      await this.bookings.onPaymentVerified(c, p.id, p.bookingId);
    });
  }

  /** C09 client callback: never trusted on its own, it only triggers a server-side fetch. */
  async verifyFromClient(userId: string, dto: VerifyPaymentDto) {
    const p = await this.db.maybe<PaymentRow>('select * from payment where provider_order_id = $1 and user_id = $2', [dto.razorpayOrderId, userId]);
    if (!p) throw notFound('Payment');
    if (!this.gateway.verifyCheckoutSignature(dto.razorpayOrderId, dto.razorpayPaymentId, dto.razorpaySignature)) {
      throw badRequest('SIGNATURE_INVALID', 'Payment signature is invalid');
    }
    const e = await this.gateway.fetchPayment(dto.razorpayPaymentId);
    if (e && e.providerOrderId === dto.razorpayOrderId) await this.apply(e);
    return this.status(userId, p.id);
  }

  async status(userId: string, paymentId: string) {
    const r = await this.db.maybe(
      `select p.id, p.internal_ref, p.status, p.amount_paise, p.provider_payment_id, p.failure_reason, p.verified_at, p.created_at,
              b.id as booking_id, b.internal_ref as booking_ref, b.status as booking_status
       from payment p join booking b on b.id = p.booking_id where p.id = $1 and p.user_id = $2`,
      [paymentId, userId],
    );
    if (!r) throw notFound('Payment');
    return r;
  }

  /** REFUND job. Idempotent: skips once a refund id is recorded. */
  async handle({ paymentId }: { paymentId: string }) {
    const p = await this.db.maybe<PaymentRow>('select * from payment where id = $1', [paymentId]);
    if (!p || p.status !== 'REFUND_PENDING' || p.providerRefundId || !p.providerPaymentId) return;
    const refundId = await this.gateway.refund(p.providerPaymentId, p.amountPaise, p.internalRef);
    await this.db.exec('update payment set provider_refund_id = $2, updated_at = now() where id = $1', [p.id, refundId]);
  }
}

export class VerifyPaymentDto {
  @IsString() @IsNotEmpty() @MaxLength(100) razorpayOrderId: string;
  @IsString() @IsNotEmpty() @MaxLength(100) razorpayPaymentId: string;
  @IsString() @IsNotEmpty() @MaxLength(200) razorpaySignature: string;
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly db: Db,
  ) {}

  @Post('verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body() dto: VerifyPaymentDto) {
    return this.payments.verifyFromClient(u.id, dto);
  }

  /** C13 */
  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    const items = await this.db.many(
      `select p.id, p.internal_ref, p.amount_paise, p.status, p.provider_payment_id, p.failure_reason, p.verified_at, p.created_at,
              b.internal_ref as booking_ref, pl.plot_no
       from payment p join booking b on b.id = p.booking_id join plot pl on pl.id = b.plot_id
       where p.user_id = $1 order by p.created_at desc limit $2 offset $3`,
      [u.id, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from payment where user_id = $1', [u.id]);
    return { items, page: q.page, size: q.size, total };
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.status(u.id, id);
  }

  /** Receipt data for verified payments; the app renders/prints it. */
  @Get(':id/receipt')
  async receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.maybe(
      `select p.internal_ref as receipt_no, p.amount_paise, p.provider_payment_id, p.verified_at,
              b.internal_ref as booking_ref, pl.plot_no, t.name as tier_name, usr.name as customer_name, usr.mobile, usr.email
       from payment p join booking b on b.id = p.booking_id join plot pl on pl.id = b.plot_id
       join tier t on t.id = b.tier_id join app_user usr on usr.id = p.user_id
       where p.id = $1 and p.user_id = $2 and p.status in ('VERIFIED', 'REFUND_PENDING', 'REFUNDED')`,
      [id, u.id],
    );
    if (!r) throw notFound('Receipt');
    return r;
  }
}

@Public()
@SkipThrottle()
@ApiTags('Webhooks')
@Controller('webhooks')
export class PaymentWebhookController {
  private readonly log = new Logger('webhook');

  constructor(
    private readonly payments: PaymentService,
    private readonly gateway: PaymentGateway,
  ) {}

  /** Always 2xx after durable processing; Razorpay retries on non-2xx. */
  @Post('razorpay')
  @HttpCode(200)
  async razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') sig: string,
    @Headers('x-razorpay-event-id') eventId: string,
  ) {
    const raw = req.rawBody;
    if (!raw || !this.gateway.verifyWebhook(raw, sig)) {
      this.log.warn('razorpay webhook signature rejected');
      throw unauthorized('SIGNATURE_INVALID', 'Invalid signature');
    }
    const e = this.gateway.parseWebhook(raw, eventId || `body:${sha256(raw.toString('utf8'))}`);
    if (e) await this.payments.apply(e, raw.toString('utf8'));
    return { ok: true };
  }
}
