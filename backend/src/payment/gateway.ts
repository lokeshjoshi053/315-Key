import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, Config } from '../config';
import { providerError } from '../common/http';
import { hmac, safeEqual } from '../common/support';

/** Provider-neutral payment event. Everything downstream speaks this, never Razorpay JSON. */
export interface PaymentEvent {
  providerEventId: string;
  type: 'CAPTURED' | 'FAILED' | 'REFUNDED';
  providerOrderId: string | null;
  providerPaymentId: string;
  amountPaise: number;
  reason?: string;
}

/** Vendor edge (C7). Abstract class doubles as the Nest DI token; tests swap a fake. */
export abstract class PaymentGateway {
  abstract readonly publicKey: string;
  abstract createOrder(receipt: string, amountPaise: number): Promise<{ providerOrderId: string }>;
  abstract verifyWebhook(raw: Buffer, signature: string): boolean;
  abstract parseWebhook(raw: Buffer, eventId: string): PaymentEvent | null;
  abstract verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  abstract fetchPayment(providerPaymentId: string): Promise<PaymentEvent | null>;
  abstract refund(providerPaymentId: string, amountPaise: number, receipt: string): Promise<string>;
}

/**
 * Razorpay Orders API. VERIFY against current docs before go-live:
 * webhook signature = hex HMAC-SHA256(raw body, webhook secret) in X-Razorpay-Signature;
 * checkout signature = HMAC(order_id|payment_id, key secret); account set to auto-capture.
 */
@Injectable()
export class RazorpayGateway extends PaymentGateway {

  constructor(@Inject(CONFIG) private readonly cfg: Config) {
    super();
  }

  get publicKey() {
    return this.cfg.razorpay.keyId;
  }

  private async call(path: string, init: RequestInit = {}) {
    const auth = Buffer.from(`${this.cfg.razorpay.keyId}:${this.cfg.razorpay.keySecret}`).toString('base64');
    const res = await fetch(this.cfg.razorpay.baseUrl + path, {
      ...init,
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw providerError(`Payment provider error: ${body?.error?.description ?? res.status}`);
    return body;
  }

  async createOrder(receipt: string, amountPaise: number) {
    const o = await this.call('/orders', { method: 'POST', body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }) });
    return { providerOrderId: o.id as string };
  }

  verifyWebhook(raw: Buffer, signature: string) {
    return !!signature && !!this.cfg.razorpay.webhookSecret && safeEqual(hmac(this.cfg.razorpay.webhookSecret, raw), signature);
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
    return safeEqual(hmac(this.cfg.razorpay.keySecret, `${orderId}|${paymentId}`), signature);
  }

  parseWebhook(raw: Buffer, eventId: string): PaymentEvent | null {
    const b = JSON.parse(raw.toString('utf8'));
    switch (b.event) {
      case 'payment.captured':
      case 'payment.failed': {
        const p = b.payload.payment.entity;
        return {
          providerEventId: eventId,
          type: b.event === 'payment.captured' ? 'CAPTURED' : 'FAILED',
          providerOrderId: p.order_id,
          providerPaymentId: p.id,
          amountPaise: p.amount,
          reason: p.error_description ?? undefined,
        };
      }
      case 'refund.processed': {
        const r = b.payload.refund.entity;
        return { providerEventId: eventId, type: 'REFUNDED', providerOrderId: null, providerPaymentId: r.payment_id, amountPaise: r.amount };
      }
      default:
        return null;
    }
  }

  async fetchPayment(providerPaymentId: string): Promise<PaymentEvent | null> {
    const p = await this.call(`/payments/${encodeURIComponent(providerPaymentId)}`);
    if (p.status !== 'captured' && p.status !== 'failed') return null; // still authorized/created: wait for webhook
    return {
      providerEventId: `fetch:${p.id}:${p.status}`,
      type: p.status === 'captured' ? 'CAPTURED' : 'FAILED',
      providerOrderId: p.order_id,
      providerPaymentId: p.id,
      amountPaise: p.amount,
      reason: p.error_description ?? undefined,
    };
  }

  async refund(providerPaymentId: string, amountPaise: number, receipt: string) {
    const r = await this.call(`/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: amountPaise, receipt }),
    });
    return r.id as string;
  }
}
