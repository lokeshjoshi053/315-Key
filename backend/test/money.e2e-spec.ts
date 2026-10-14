/**
 * The correctness tests from SRS §7: booking race (AC-1), webhook idempotency (AC-2),
 * commission math end to end (AC-4), reversal (AC-5), authz (AC-8). Real Postgres via Testcontainers.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { Db as DbT } from '../src/db';

class FakeGateway {
  publicKey = 'rzp_test_fake';
  async createOrder(receipt: string) {
    return { providerOrderId: `order_${receipt}` };
  }
  verifyWebhook() {
    return true;
  }
  parseWebhook() {
    return null;
  }
  verifyCheckoutSignature() {
    return true;
  }
  async fetchPayment() {
    return null;
  }
  async refund() {
    return 'rfnd_fake';
  }
}

let pg: StartedPostgreSqlContainer;
let app: INestApplication;
let db: DbT;
let token: (id: string, role?: string) => string;

async function user(name: string, opts: { sponsor?: string; leg?: 'L' | 'R'; partner?: boolean } = {}) {
  const { id } = await db.one<{ id: string }>(
    `insert into app_user (name, mobile, partner_status, referral_code, sponsor_id, leg)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [name, `9${Math.floor(1e8 + Math.random() * 9e8)}`, opts.partner ? 'APPROVED' : 'NONE', opts.partner ? `P${name.toUpperCase()}` : null, opts.sponsor ?? null, opts.sponsor ? opts.leg ?? 'L' : null],
  );
  return id;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  Object.assign(process.env, {
    DATABASE_URL: pg.getConnectionUri(),
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    CRYPTO_KEY: Buffer.alloc(32, 7).toString('base64'),
    JOBS_ENABLED: 'false',
    APP_ENV: 'test',
  });
  const { AppModule } = await import('../src/app.module');
  const { PaymentGateway } = await import('../src/payment/gateway');
  const { Db, migrate } = await import('../src/db');
  const { configureApp } = await import('../src/main');

  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PaymentGateway).useClass(FakeGateway).compile();
  app = mod.createNestApplication({ rawBody: true });
  await configureApp(app);
  await app.init();
  db = app.get(Db);
  await migrate(db.pool);
  const jwt = app.get(JwtService);
  token = (id, role = 'USER') => jwt.sign({ sub: id, role });
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('money path', () => {
  let l3: string, l2: string, l1: string, buyer: string, plotId: string, gold: { id: string; amountPaise: number };

  beforeAll(async () => {
    l3 = await user('top', { partner: true });
    l2 = await user('mid', { partner: true, sponsor: l3, leg: 'R' });
    l1 = await user('direct', { partner: true, sponsor: l2, leg: 'L' });
    buyer = await user('buyer', { sponsor: l1, leg: 'L' });
    plotId = (await db.one<{ id: string }>(`select id from plot where plot_no = 'P-001'`)).id;
    gold = await db.one(`select id, amount_paise from tier where code = 'GOLD'`);
  });

  it('AC-1: 20 concurrent bookings for one plot → exactly one wins', async () => {
    const racers = [buyer, ...(await Promise.all(Array.from({ length: 19 }, (_, i) => user(`racer${i}`))))];
    const results = await Promise.all(
      racers.map((id) =>
        request(app.getHttpServer())
          .post('/bookings')
          .set('authorization', `Bearer ${token(id)}`)
          .send({ plotId, tierId: gold.id, termsAccepted: true }),
      ),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    // make sure the winner is our buyer for the next tests; otherwise reassign
    const winner = await db.one<{ userId: string }>(`select user_id from booking where plot_id = $1 and status = 'PENDING_PAYMENT'`, [plotId]);
    if (winner.userId !== buyer) {
      await db.exec(`update booking set user_id = $1 where plot_id = $2`, [buyer, plotId]);
      await db.exec(`update payment set user_id = $1 where booking_id in (select id from booking where plot_id = $2)`, [buyer, plotId]);
    }
  });

  it('AC-2: same capture webhook 10× → one confirmation, three commission rows', async () => {
    const { PaymentService } = await import('../src/payment/payments');
    const svc = app.get(PaymentService);
    const p = await db.one<{ providerOrderId: string; amountPaise: number }>(
      `select p.provider_order_id, p.amount_paise from payment p join booking b on b.id = p.booking_id where b.plot_id = $1`,
      [plotId],
    );
    const evt = { providerEventId: 'evt_1', type: 'CAPTURED' as const, providerOrderId: p.providerOrderId, providerPaymentId: 'pay_1', amountPaise: p.amountPaise };
    await Promise.all(Array.from({ length: 10 }, () => svc.apply(evt).catch(() => undefined)));
    // also a "different" event id for the same payment (fetch fallback) must be a no-op
    await svc.apply({ ...evt, providerEventId: 'fetch:pay_1:captured' });

    expect((await db.one<{ status: string }>(`select status from plot where id = $1`, [plotId])).status).toBe('BOOKED');
    expect((await db.many(`select 1 from booking where plot_id = $1 and status = 'CONFIRMED'`, [plotId]))).toHaveLength(1);
    const rows = await db.many<{ userId: string; level: number; grossPaise: number; netPaise: number }>(
      `select user_id, level, gross_paise, net_paise from ledger_entry where kind = 'COMMISSION' order by level`,
    );
    // AC-4: Gold ₹3,00,000 → L1 ₹60,000 / ₹45,000 net, L2+L3 ₹30,000 / ₹22,500 net
    expect(rows).toEqual([
      { userId: l1, level: 1, grossPaise: 6_000_000, netPaise: 4_500_000 },
      { userId: l2, level: 2, grossPaise: 3_000_000, netPaise: 2_250_000 },
      { userId: l3, level: 3, grossPaise: 3_000_000, netPaise: 2_250_000 },
    ]);
    // volume went up every ancestor's correct leg
    const vol = await db.many<{ userId: string; leftPaise: number; rightPaise: number }>(`select user_id, left_paise, right_paise from match_volume`);
    expect(vol).toEqual(
      expect.arrayContaining([
        { userId: l1, leftPaise: 30_000_000, rightPaise: 0 },
        { userId: l2, leftPaise: 30_000_000, rightPaise: 0 },
        { userId: l3, leftPaise: 0, rightPaise: 30_000_000 },
      ]),
    );
  });

  it('ledger is append-only at the database level', async () => {
    await expect(db.exec(`update ledger_entry set net_paise = 0`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`delete from ledger_entry`)).rejects.toThrow(/append-only/);
  });

  it('AC-5: admin cancel reverses every derived ledger amount to zero and frees the plot', async () => {
    const admin = await db.one<{ id: string }>(`insert into app_user (name, role) values ('Admin', 'ADMIN') returning id`);
    const b = await db.one<{ id: string }>(`select id from booking where plot_id = $1 and status = 'CONFIRMED'`, [plotId]);
    const res = await request(app.getHttpServer())
      .post(`/admin/bookings/${b.id}/cancel`)
      .set('authorization', `Bearer ${token(admin.id, 'ADMIN')}`)
      .send({ refund: true, reason: 'test' });
    expect(res.status).toBe(201);
    const { sum } = await db.one<{ sum: number }>(`select coalesce(sum(net_paise), 0) as sum from ledger_entry where source_booking_id = $1`, [b.id]);
    expect(sum).toBe(0);
    expect((await db.one<{ status: string }>(`select status from plot where id = $1`, [plotId])).status).toBe('AVAILABLE');
    expect((await db.many(`select 1 from job where type = 'REFUND'`))).toHaveLength(1);
    expect((await db.many(`select 1 from audit_log where action = 'BOOKING_CANCEL'`))).toHaveLength(1);
  });

  it('AC-8: authz — no token 401, USER on /admin 403, cross-user read 404', async () => {
    const server = app.getHttpServer();
    expect((await request(server).get('/me')).status).toBe(401);
    expect((await request(server).get('/admin/dashboard').set('authorization', `Bearer ${token(buyer)}`)).status).toBe(403);
    const other = await user('other');
    const b = await db.one<{ id: string }>(`select id from booking where user_id = $1 limit 1`, [buyer]);
    expect((await request(server).get(`/bookings/${b.id}`).set('authorization', `Bearer ${token(other)}`)).status).toBe(404);
  });

  it('OTP login creates the user under the referral sponsor', async () => {
    const server = app.getHttpServer();
    const mobile = '9876543210';
    expect((await request(server).post('/auth/otp/request').send({ mobile })).status).toBe(200);
    // test reads the code by brute-checking hash is not possible; overwrite the challenge with a known code
    const { sha256 } = await import('../src/common/support');
    await db.exec(`update otp_challenge set code_hash = $2 where mobile = $1`, [mobile, sha256(`${mobile}:123456`)]);
    const bad = await request(server).post('/auth/otp/verify').send({ mobile, code: '000000' });
    expect(bad.body.code).toBe('OTP_INVALID');
    const ok = await request(server).post('/auth/otp/verify').send({ mobile, code: '123456', referralCode: 'PDIRECT' });
    expect(ok.status).toBe(200);
    expect(ok.body.isNewUser).toBe(true);
    const u = await db.one<{ sponsorId: string }>(`select sponsor_id from app_user where mobile = $1`, [mobile]);
    expect(u.sponsorId).toBe(l1);
    const refreshed = await request(server).post('/auth/refresh').send({ refreshToken: ok.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const reused = await request(server).post('/auth/refresh').send({ refreshToken: ok.body.refreshToken });
    expect(reused.body.code).toBe('TOKEN_REUSED');
  });
});
