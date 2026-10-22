// Live end-to-end test of the running API over HTTP. Every step asserts; prints a PASS/FAIL table.
const { createHmac } = require('crypto');
const { readFileSync } = require('fs');
const { execSync } = require('child_process');

const API = 'http://localhost:3998';
const MOCK = 'http://localhost:4010';
const LOG = process.argv[2];
const RZP_SECRET = 'rzp_secret_test';
const RZP_WH = 'rzp_webhook_test';
const CF_SECRET = 'cf_secret_test';

const results = [];
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    failed++;
    results.push(['FAIL', `${name} → ${e.message}`]);
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};
const eq = (a, b, what) => assert(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`docker exec p315-pg psql -U plots315 -d plots315 -tAc "${q.replace(/"/g, '\\"')}"`).toString().trim();

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const ok = (r, code = 200) => {
  assert(r.status === code, `HTTP ${r.status} (want ${code}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};

async function login(mobile, extra = {}) {
  ok(await call('POST', '/auth/otp/request', { body: { mobile } }));
  await sleep(150);
  const m = [...readFileSync(LOG, 'utf8').matchAll(new RegExp(`DEV OTP for ${mobile}: (\\d{6})`, 'g'))].pop();
  assert(m, `OTP for ${mobile} not found in log`);
  return ok(await call('POST', '/auth/otp/verify', { body: { mobile, code: m[1], ...extra } }));
}

async function rzpWebhook(event, entity, eventId) {
  const payload = event.startsWith('refund') ? { refund: { entity } } : { payment: { entity } };
  const raw = JSON.stringify({ event, payload });
  const sig = createHmac('sha256', RZP_WH).update(raw).digest('hex');
  return call('POST', '/webhooks/razorpay', { raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } });
}

async function pay(token, checkout, payId) {
  await fetch(MOCK + '/_mock/payment', {
    method: 'POST',
    body: JSON.stringify({ id: payId, order_id: checkout.razorpayOrderId, amount: checkout.amountPaise, status: 'captured' }),
  });
  const sig = createHmac('sha256', RZP_SECRET).update(`${checkout.razorpayOrderId}|${payId}`).digest('hex');
  return call('POST', '/payments/verify', { token, body: { razorpayOrderId: checkout.razorpayOrderId, razorpayPaymentId: payId, razorpaySignature: sig } });
}

const profile = (token, name) => call('PUT', '/me', { token, body: { name, email: `${name.toLowerCase().replace(/\s/g, '')}@example.com`, address: 'Pune' } });

(async () => {
  const S = {}; // shared state

  // ---------- platform ----------
  await step('health + swagger + request id', async () => {
    eq(ok(await call('GET', '/health')).status, 'ok', 'health');
    eq((await call('GET', '/docs')).status, 200, 'docs');
    const r = await fetch(API + '/health');
    assert(r.headers.get('x-request-id'), 'missing X-Request-Id');
  });
  await step('swagger: every operation documented, page served with title', async () => {
    const d = ok(await call('GET', '/docs-json'));
    const ops = Object.values(d.paths).flatMap((p) => Object.values(p));
    assert(ops.length >= 74, `only ${ops.length} operations`);
    const undocumented = ops.filter((o) => !o.summary || !Object.keys(o.responses).some((c) => c >= 400));
    eq(undocumented.length, 0, 'operations without summary/errors');
    eq(d.paths['/bookings'].post.requestBody.content['application/json'].example.termsAccepted, true, 'request example');
    const html = await (await fetch(API + '/docs')).text();
    assert(html.includes('315 PLOTS API'), 'docs page title');
  });
  await step('no token → 401 with error envelope', async () => {
    const r = await call('GET', '/me');
    eq(r.status, 401, 'status');
    assert(r.body.code && r.body.requestId, 'envelope');
  });
  await step('cron endpoints reject calls without the secret', async () => {
    eq((await call('GET', '/internal/cron/minute')).status, 401, 'no auth');
    eq((await call('GET', '/internal/cron/daily', { headers: { authorization: 'Bearer wrong' } })).status, 401, 'wrong secret');
  });
  await step('validation: bad mobile → 400 VALIDATION_FAILED', async () => {
    const r = await call('POST', '/auth/otp/request', { body: { mobile: '12345' } });
    eq(r.status, 400, 'status');
    eq(r.body.code, 'VALIDATION_FAILED', 'code');
  });
  await step('validation: unknown field rejected', async () => {
    eq((await call('POST', '/auth/otp/request', { body: { mobile: '9123456780', role: 'ADMIN' } })).status, 400, 'status');
  });

  // ---------- auth ----------
  await step('admin OTP login (bootstrap admin)', async () => {
    const t = await login('9000000001');
    S.admin = t.accessToken;
    eq(ok(await call('GET', '/me/bootstrap', { token: S.admin })).user.role, 'ADMIN', 'role');
  });
  await step('wrong OTP → OTP_INVALID; attempts counted', async () => {
    ok(await call('POST', '/auth/otp/request', { body: { mobile: '9000000099' } }));
    const r = await call('POST', '/auth/otp/verify', { body: { mobile: '9000000099', code: '000001' } });
    eq(r.body.code, 'OTP_INVALID', 'code');
    eq(sql(`select attempts from otp_challenge where mobile='9000000099' order by created_at desc limit 1`), '1', 'attempts');
  });
  await step('OTP resend limit → 429 after 3 sends', async () => {
    const m = '9000000098';
    for (let i = 0; i < 3; i++) ok(await call('POST', '/auth/otp/request', { body: { mobile: m } }));
    eq((await call('POST', '/auth/otp/request', { body: { mobile: m } })).status, 429, 'status');
  });
  await step('Google sign-in without config → 501', async () => {
    eq((await call('POST', '/auth/google', { body: { idToken: 'x' } })).status, 501, 'status');
  });

  // ---------- partner network: A ← B ← C ← buyer ----------
  async function partner(key, mobile, name, referralCode) {
    const t = await login(mobile, referralCode ? { referralCode } : {});
    S[key] = t.accessToken;
    S[key + 'Refresh'] = t.refreshToken;
    ok(await profile(S[key], name));
    eq(ok(await call('POST', '/partners/apply', { token: S[key] }, 201), 201).partnerStatus, 'PENDING', 'apply');
    const me = ok(await call('GET', '/me', { token: S[key] }));
    S[key + 'Id'] = me.id;
    const a = ok(await call('POST', `/admin/users/${me.id}/partner`, { token: S.admin, body: { action: 'APPROVE' } }), 201);
    eq(a.partnerStatus, 'APPROVED', 'approved');
    S[key + 'Code'] = a.referralCode;
  }
  await step('partner A signup, apply, admin approve → referral code', () => partner('A', '9000000002', 'Partner A'));
  await step('partner B joins with A\'s code', () => partner('B', '9000000003', 'Partner B', S.ACode));
  await step('partner C joins with B\'s code', () => partner('C', '9000000004', 'Partner C', S.BCode));
  await step('invalid referral code → 400 INVALID_REFERRAL', async () => {
    ok(await call('POST', '/auth/otp/request', { body: { mobile: '9000000097' } }));
    await sleep(150);
    const code = [...readFileSync(LOG, 'utf8').matchAll(/DEV OTP for 9000000097: (\d{6})/g)].pop()[1];
    eq((await call('POST', '/auth/otp/verify', { body: { mobile: '9000000097', code, referralCode: 'NOPE99' } })).body.code, 'INVALID_REFERRAL', 'code');
  });
  await step('partners/me shows code + link', async () => {
    const r = ok(await call('GET', '/partners/me', { token: S.A }));
    eq(r.referralCode, S.ACode, 'code');
    assert(r.referralLink.endsWith(S.ACode), 'link');
  });
  await step('partner C registers a lead; lead later signs up and auto-links', async () => {
    ok(await call('POST', '/leads', { token: S.C, body: { name: 'Buyer One', mobile: '9000000010' } }), 201);
    const t = await login('9000000010'); // no referral code: sponsor comes from the lead
    S.buyer = t.accessToken;
    S.buyerRefresh = t.refreshToken;
    const me = ok(await call('GET', '/me', { token: S.buyer }));
    S.buyerId = me.id;
    eq(me.sponsorId, S.CId, 'sponsor from lead');
    const leads = ok(await call('GET', '/leads', { token: S.C }));
    eq(leads.items[0].status, 'REGISTERED', 'lead status');
  });
  await step('A sees 3-level network with masked mobiles', async () => {
    const r = ok(await call('GET', '/partners/network', { token: S.A }));
    eq(r.total, 3, 'members');
    assert(r.items.every((i) => i.mobile.startsWith('******')), 'masked');
    eq(ok(await call('GET', '/partners/network?level=3', { token: S.A })).total, 1, 'level 3');
  });
  await step('non-partner blocked from partner endpoints → 403', async () => {
    eq((await call('GET', '/commissions', { token: S.buyer })).body.code, 'PARTNER_NOT_APPROVED', 'code');
  });

  // ---------- profile ----------
  await step('booking with incomplete profile → PROFILE_INCOMPLETE', async () => {
    const plots = ok(await call('GET', '/plots?size=5', { token: S.buyer }));
    const tiers = ok(await call('GET', '/tiers', { token: S.buyer }));
    S.plots = plots.items;
    S.gold = tiers.find((t) => t.code === 'GOLD');
    S.express = tiers.find((t) => t.code === 'EXPRESS');
    const r = await call('POST', '/bookings', { token: S.buyer, body: { plotId: S.plots[0].id, tierId: S.gold.id, termsAccepted: true } });
    eq(r.body.code, 'PROFILE_INCOMPLETE', 'code');
  });
  await step('profile, nominee, device token, bootstrap', async () => {
    ok(await profile(S.buyer, 'Buyer One'));
    ok(await call('PUT', '/me/nominee', { token: S.buyer, body: { name: 'Spouse', relation: 'Spouse', mobile: '9000000011' } }));
    ok(await call('POST', '/me/devices', { token: S.buyer, body: { token: 'fcm-token-abc', platform: 'android' } }), 201);
    const b = ok(await call('GET', '/me/bootstrap', { token: S.buyer }));
    eq(b.profileComplete, true, 'complete');
    eq(ok(await call('GET', '/me', { token: S.buyer })).nominee.relation, 'Spouse', 'nominee');
  });
  await step('sponsor locked once set', async () => {
    eq((await call('PUT', '/me/sponsor', { token: S.buyer, body: { referralCode: S.ACode } })).status, 409, 'status');
  });

  // ---------- plots ----------
  await step('plots: 315 seeded, filters, detail, 5 tiers with PDF amounts', async () => {
    const r = ok(await call('GET', '/plots?status=AVAILABLE&size=50', { token: S.buyer }));
    eq(r.total, 315, 'available');
    eq(r.items.length, 50, 'page size');
    eq(ok(await call('GET', `/plots/${S.plots[0].id}`, { token: S.buyer })).plotNo, 'P-001', 'detail');
    const tiers = ok(await call('GET', '/tiers', { token: S.buyer }));
    eq(tiers.map((t) => t.amountPaise).join(), '2100000,7100000,15100000,30000000,65100000', 'tier amounts');
    eq((await call('GET', '/plots?size=999', { token: S.buyer })).status, 400, 'size cap');
  });

  // ---------- booking + payment ----------
  await step('book P-001 Gold → checkout with Razorpay order, plot HELD', async () => {
    const c = ok(await call('POST', '/bookings', { token: S.buyer, body: { plotId: S.plots[0].id, tierId: S.gold.id, termsAccepted: true } }), 201);
    assert(c.razorpayOrderId.startsWith('order_mock_'), 'order id');
    eq(c.amountPaise, 30000000, 'amount from tier');
    assert(/^BK-\d{4}-\d{6}$/.test(c.bookingRef), 'booking ref format');
    S.checkout = c;
    eq(ok(await call('GET', `/plots/${S.plots[0].id}`, { token: S.buyer })).status, 'HELD', 'plot status');
  });
  await step('terms not accepted → 400', async () => {
    eq((await call('POST', '/bookings', { token: S.A, body: { plotId: S.plots[1].id, tierId: S.gold.id, termsAccepted: false } })).status, 400, 'status');
  });
  await step('another user cannot book a HELD plot → 409 PLOT_UNAVAILABLE', async () => {
    eq((await call('POST', '/bookings', { token: S.A, body: { plotId: S.plots[0].id, tierId: S.gold.id, termsAccepted: true } })).body.code, 'PLOT_UNAVAILABLE', 'code');
  });
  await step('same user cannot open a second checkout → PENDING_BOOKING_EXISTS', async () => {
    eq((await call('POST', '/bookings', { token: S.buyer, body: { plotId: S.plots[1].id, tierId: S.gold.id, termsAccepted: true } })).body.code, 'PENDING_BOOKING_EXISTS', 'code');
  });
  await step('forged checkout signature → SIGNATURE_INVALID, booking unchanged', async () => {
    const r = await call('POST', '/payments/verify', { token: S.buyer, body: { razorpayOrderId: S.checkout.razorpayOrderId, razorpayPaymentId: 'pay_x', razorpaySignature: 'deadbeef' } });
    eq(r.body.code, 'SIGNATURE_INVALID', 'code');
    eq(ok(await call('GET', `/bookings/${S.checkout.bookingId}`, { token: S.buyer })).status, 'PENDING_PAYMENT', 'still pending');
  });
  await step('client verify → server fetches provider → booking CONFIRMED, plot BOOKED', async () => {
    const r = ok(await pay(S.buyer, S.checkout, 'pay_mock_1'));
    eq(r.status, 'VERIFIED', 'payment');
    eq(r.bookingStatus, 'CONFIRMED', 'booking');
    eq(ok(await call('GET', `/plots/${S.plots[0].id}`, { token: S.buyer })).status, 'BOOKED', 'plot');
  });
  await step('Razorpay webhook replay ×5 after verify → no duplicates', async () => {
    const entity = { id: 'pay_mock_1', order_id: S.checkout.razorpayOrderId, amount: S.checkout.amountPaise };
    for (let i = 0; i < 5; i++) ok(await rzpWebhook('payment.captured', entity, 'evt_capture_1'));
    ok(await rzpWebhook('payment.captured', entity, 'evt_capture_1_other_id'));
    eq(sql(`select count(*) from ledger_entry where source_booking_id='${S.checkout.bookingId}'`), '3', 'commission rows');
    eq(sql(`select count(*) from booking where plot_id='${S.plots[0].id}' and status='CONFIRMED'`), '1', 'bookings');
  });
  await step('webhook with bad signature → 401', async () => {
    const r = await call('POST', '/webhooks/razorpay', { raw: '{"event":"payment.captured"}', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad' } });
    eq(r.status, 401, 'status');
  });
  await step('booking detail, payment list, receipt', async () => {
    const b = ok(await call('GET', `/bookings/${S.checkout.bookingId}`, { token: S.buyer }));
    eq(b.plot.plotNo, 'P-001', 'plot');
    eq(b.payments[0].providerPaymentId, 'pay_mock_1', 'provider ref');
    const pays = ok(await call('GET', '/payments', { token: S.buyer }));
    eq(pays.items[0].status, 'VERIFIED', 'payment list');
    const rc = ok(await call('GET', `/payments/${S.checkout.paymentId}/receipt`, { token: S.buyer }));
    eq(rc.tierName, 'Gold', 'receipt tier');
    eq(rc.customerName, 'Buyer One', 'receipt name');
  });
  await step('cross-user access → 404', async () => {
    eq((await call('GET', `/bookings/${S.checkout.bookingId}`, { token: S.A })).status, 404, 'booking');
    eq((await call('GET', `/payments/${S.checkout.paymentId}/receipt`, { token: S.A })).status, 404, 'receipt');
  });

  // ---------- commission + matching ----------
  await step('commission: C L1 ₹60,000 gross / ₹45,000 net; B L2 and A L3 ₹30,000 / ₹22,500', async () => {
    const c = ok(await call('GET', '/commissions', { token: S.C })).items[0];
    eq([c.level, c.grossPaise, c.adminPaise, c.tdsPaise, c.netPaise, c.status].join(), '1,6000000,1200000,300000,4500000,PENDING', 'C');
    const b = ok(await call('GET', '/commissions', { token: S.B })).items[0];
    eq([b.level, b.grossPaise, b.netPaise].join(), '2,3000000,2250000', 'B');
    const a = ok(await call('GET', '/commissions', { token: S.A })).items[0];
    eq([a.level, a.grossPaise, a.netPaise].join(), '3,3000000,2250000', 'A');
    S.cEntry = c.id;
  });
  await step('commission detail has booking context + status history; summary', async () => {
    const d = ok(await call('GET', `/commissions/${S.cEntry}`, { token: S.C }));
    eq(d.plotNo, 'P-001', 'plot');
    eq(d.history[0].status, 'PENDING', 'history');
    const s = ok(await call('GET', '/commissions/summary', { token: S.C }));
    eq(s.byStatus[0].netPaise, 4500000, 'summary');
    eq((await call('GET', `/commissions/${S.cEntry}`, { token: S.A })).status, 404, 'other user');
  });
  await step('matching volume reached every upline on the right leg', async () => {
    const m = ok(await call('GET', '/matching/summary', { token: S.A }));
    eq(m.leftVolumePaise + m.rightVolumePaise, 30000000, 'A volume');
    ok(await call('GET', '/matching/runs', { token: S.A }));
  });
  await step('notifications: buyer + partners got inbox entries; mark read', async () => {
    const n = ok(await call('GET', '/notifications', { token: S.buyer }));
    assert(n.items.some((i) => i.title === 'Booking confirmed' && i.deepLink === `booking/${S.checkout.bookingId}`), 'booking notification');
    ok(await call('POST', `/notifications/${n.items[0].id}/read`, { token: S.buyer }), 201);
    ok(await call('POST', '/notifications/read-all', { token: S.buyer }), 201);
    eq(ok(await call('GET', '/notifications', { token: S.buyer })).unread, 0, 'unread');
    assert(ok(await call('GET', '/notifications', { token: S.C })).items.some((i) => i.category === 'COMMISSION'), 'commission notification');
    await sleep(2500);
    eq(sql(`select count(*) from job where type='PUSH' and done_at is null`), '0', 'push jobs drained');
  });

  // ---------- admin ledger + payout ----------
  await step('admin approve before eligible changes nothing', async () => {
    eq(ok(await call('POST', '/admin/commissions/approve', { token: S.admin, body: { ids: [S.cEntry] } }), 201).changed, 0, 'changed');
  });
  await step('admin hold → release → approve (ELIGIBLE → APPROVED)', async () => {
    eq(ok(await call('POST', '/admin/commissions/hold', { token: S.admin, body: { ids: [S.cEntry], note: 'review' } }), 201).changed, 1, 'hold');
    eq(ok(await call('POST', '/admin/commissions/release', { token: S.admin, body: { ids: [S.cEntry] } }), 201).changed, 1, 'release');
    eq(ok(await call('POST', '/admin/commissions/approve', { token: S.admin, body: { ids: [S.cEntry] } }), 201).changed, 1, 'approve');
  });
  await step('payout without beneficiary → none created', async () => {
    eq(ok(await call('POST', '/admin/payouts', { token: S.admin, body: {} }), 201).created, 0, 'created');
  });
  await step('beneficiary: validation, encrypted at rest, masked in API', async () => {
    eq((await call('PUT', '/payouts/beneficiary', { token: S.C, body: { holderName: 'C', accountNumber: '12', ifsc: 'bad', pan: 'x' } })).status, 400, 'validation');
    const b = ok(await call('PUT', '/payouts/beneficiary', { token: S.C, body: { holderName: 'Partner C', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' } }));
    eq(b.accountMasked, '****9012', 'masked');
    eq(sql(`select position('123456789012' in encode(account_enc,'escape')) from beneficiary`), '0', 'not plaintext');
  });
  await step('admin payout batch → Cashfree transfer → PROCESSING', async () => {
    const r = ok(await call('POST', '/admin/payouts', { token: S.admin, body: {} }), 201);
    eq(r.created, 1, 'created');
    eq(r.results[0].amountPaise, 4500000, 'net amount');
    eq(r.results[0].status, 'PROCESSING', 'status');
    S.payoutRef = r.results[0].payoutRef;
    eq(ok(await call('POST', '/admin/payouts', { token: S.admin, body: {} }), 201).created, 0, 'no double payout');
  });
  await step('Cashfree success webhook (signed) → PAID, ledger PAID; replay safe', async () => {
    const raw = JSON.stringify({ type: 'TRANSFER_SUCCESS', data: { transfer_id: S.payoutRef } });
    const ts = String(Date.now());
    const sig = createHmac('sha256', CF_SECRET).update(ts + raw).digest('base64');
    for (let i = 0; i < 3; i++) ok(await call('POST', '/webhooks/cashfree', { raw, headers: { 'content-type': 'application/json', 'x-webhook-signature': sig, 'x-webhook-timestamp': ts } }));
    const p = ok(await call('GET', '/payouts', { token: S.C }));
    eq(p.items[0].status, 'PAID', 'payout');
    eq(p.availablePaise, 0, 'available');
    eq(ok(await call('GET', `/commissions/${S.cEntry}`, { token: S.C })).status, 'PAID', 'ledger');
    eq(sql(`select count(*) from ledger_entry_status s join ledger_entry e on e.id=s.ledger_entry_id where e.id='${S.cEntry}' and s.status='PAID'`), '1', 'single PAID row');
  });
  await step('Cashfree webhook bad signature → 401', async () => {
    eq((await call('POST', '/webhooks/cashfree', { raw: '{}', headers: { 'content-type': 'application/json', 'x-webhook-signature': 'x', 'x-webhook-timestamp': '1' } })).status, 401, 'status');
  });

  // ---------- failure, retry, refund, expiry, late capture ----------
  await step('payment.failed webhook → FAILED; retry-payment opens a new order', async () => {
    const c = ok(await call('POST', '/bookings', { token: S.B, body: { plotId: S.plots[1].id, tierId: S.express.id, termsAccepted: true } }), 201);
    ok(await rzpWebhook('payment.failed', { id: 'pay_fail_1', order_id: c.razorpayOrderId, amount: c.amountPaise, error_description: 'card declined' }, 'evt_fail_1'));
    eq(ok(await call('GET', `/payments/${c.paymentId}`, { token: S.B })).status, 'FAILED', 'failed');
    const r = ok(await call('POST', `/bookings/${c.bookingId}/retry-payment`, { token: S.B }), 201);
    assert(r.razorpayOrderId !== c.razorpayOrderId, 'new order');
    S.bCheckout = r;
  });
  await step('second buyer pays via webhook only (no client verify) → CONFIRMED', async () => {
    ok(await rzpWebhook('payment.captured', { id: 'pay_mock_2', order_id: S.bCheckout.razorpayOrderId, amount: S.bCheckout.amountPaise }, 'evt_capture_2'));
    eq(ok(await call('GET', `/bookings/${S.bCheckout.bookingId}`, { token: S.B })).status, 'CONFIRMED', 'booking');
  });
  await step('amount mismatch webhook → payment FAILED, not confirmed', async () => {
    const c = ok(await call('POST', '/bookings', { token: S.C, body: { plotId: S.plots[3].id, tierId: S.express.id, termsAccepted: true } }), 201);
    ok(await rzpWebhook('payment.captured', { id: 'pay_bad_amt', order_id: c.razorpayOrderId, amount: 100 }, 'evt_bad_amt'));
    const p = ok(await call('GET', `/payments/${c.paymentId}`, { token: S.C }));
    eq(p.failureReason, 'AMOUNT_MISMATCH', 'reason');
    eq(p.bookingStatus, 'PENDING_PAYMENT', 'booking');
    S.cPending = c;
  });
  await step('admin cancel with refund → ledger reversed to 0, plot free, Razorpay refund called', async () => {
    ok(await call('POST', `/admin/bookings/${S.bCheckout.bookingId}/cancel`, { token: S.admin, body: { refund: true, reason: 'customer request' } }), 201);
    eq(sql(`select coalesce(sum(net_paise),0) from ledger_entry where source_booking_id='${S.bCheckout.bookingId}'`), '0', 'ledger net');
    eq(ok(await call('GET', `/plots/${S.plots[1].id}`, { token: S.B })).status, 'AVAILABLE', 'plot');
    await sleep(4500);
    const calls = await (await fetch(MOCK + '/_mock/calls')).json();
    assert(calls.some((c) => c.url === '/v1/payments/pay_mock_2/refund'), 'refund API not called');
    assert(sql(`select provider_refund_id from payment where provider_payment_id='pay_mock_2'`).startsWith('rfnd_mock_'), 'refund id stored');
  });
  await step('refund.processed webhook → payment + booking REFUNDED', async () => {
    ok(await rzpWebhook('refund.processed', { id: 'rfnd_x', payment_id: 'pay_mock_2', amount: S.bCheckout.amountPaise }, 'evt_refund_1'));
    eq(ok(await call('GET', `/bookings/${S.bCheckout.bookingId}`, { token: S.B })).status, 'REFUNDED', 'booking');
  });
  await step('hold expiry job frees the plot (AC-7)', async () => {
    sql(`update booking set hold_expires_at = now() - interval '1 minute' where id='${S.cPending.bookingId}'`);
    sql(`update plot set held_until = now() - interval '1 minute' where id='${S.plots[3].id}'`);
    let status;
    for (let i = 0; i < 40 && status !== 'EXPIRED'; i++) {
      await sleep(1000);
      status = sql(`select status from booking where id='${S.cPending.bookingId}'`);
    }
    eq(status, 'EXPIRED', 'booking');
    eq(sql(`select status from plot where id='${S.plots[3].id}'`), 'AVAILABLE', 'plot');
    eq((await call('POST', `/bookings/${S.cPending.bookingId}/retry-payment`, { token: S.C })).body.code, 'HOLD_EXPIRED', 'retry blocked');
  });
  await step('late capture after plot taken by someone else → auto refund queued (FR-4.6)', async () => {
    const other = ok(await call('POST', '/bookings', { token: S.A, body: { plotId: S.plots[3].id, tierId: S.express.id, termsAccepted: true } }), 201);
    const c = S.cPending;
    sql(`update payment set status='PENDING', failure_reason=null where id='${c.paymentId}'`); // undo the mismatch test so a genuine capture can land
    ok(await rzpWebhook('payment.captured', { id: 'pay_late_1', order_id: c.razorpayOrderId, amount: c.amountPaise }, 'evt_late_1'));
    eq(ok(await call('GET', `/bookings/${c.bookingId}`, { token: S.C })).status, 'REFUND_PENDING', 'late booking');
    eq(ok(await call('GET', `/bookings/${other.bookingId}`, { token: S.A })).status, 'PENDING_PAYMENT', 'new owner unaffected');
    eq(sql(`select count(*) from ledger_entry where source_booking_id='${c.bookingId}'`), '0', 'no commission on refunded booking');
  });

  // ---------- documents ----------
  await step('admin uploads PDF → buyer lists it and downloads via signed URL', async () => {
    const fd = new FormData();
    fd.append('userId', S.buyerId);
    fd.append('bookingId', S.checkout.bookingId);
    fd.append('type', 'AGREEMENT');
    fd.append('title', 'Sale Agreement');
    fd.append('file', new Blob(['%PDF-1.4 test agreement'], { type: 'application/pdf' }), 'a.pdf');
    const up = await fetch(API + '/admin/documents', { method: 'POST', headers: { authorization: `Bearer ${S.admin}` }, body: fd });
    const doc = await up.json();
    eq(up.status, 201, `upload ${JSON.stringify(doc)}`);
    const list = ok(await call('GET', '/documents', { token: S.buyer }));
    eq(list.items[0].status, 'SENT', 'status');
    const { url } = ok(await call('GET', `/documents/${doc.id}/url`, { token: S.buyer }));
    const file = await fetch(url);
    eq(file.status, 200, 'signed url');
    eq(await file.text(), '%PDF-1.4 test agreement', 'content');
    eq((await call('GET', `/documents/${doc.id}/url`, { token: S.A })).status, 404, 'other user');
    eq(ok(await call('PATCH', `/admin/documents/${doc.id}/status`, { token: S.admin, body: { status: 'SIGNED' } })).status, 'SIGNED', 'admin status');
    eq((await call('POST', `/documents/${doc.id}/sign`, { token: S.buyer })).status, 501, 'esign not configured');
  });
  await step('upload rejects non-PDF/image', async () => {
    const fd = new FormData();
    fd.append('userId', S.buyerId);
    fd.append('type', 'OTHER');
    fd.append('title', 'x');
    fd.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'x.exe');
    eq((await fetch(API + '/admin/documents', { method: 'POST', headers: { authorization: `Bearer ${S.admin}` }, body: fd })).status, 400, 'status');
  });

  // ---------- admin ----------
  await step('USER on /admin → 403', async () => {
    eq((await call('GET', '/admin/dashboard', { token: S.A })).status, 403, 'status');
  });
  await step('admin dashboard, users search, user detail, bookings, payments, ledger, payouts lists', async () => {
    const d = ok(await call('GET', '/admin/dashboard', { token: S.admin }));
    assert(d.plots.length && d.partners.approved === 3, 'dashboard');
    eq(ok(await call('GET', '/admin/users?search=Partner', { token: S.admin })).total, 3, 'search');
    eq(ok(await call('GET', `/admin/users/${S.buyerId}`, { token: S.admin })).bookings.length, 1, 'user detail');
    assert(ok(await call('GET', '/admin/bookings?status=CONFIRMED', { token: S.admin })).total >= 1, 'bookings');
    assert(ok(await call('GET', '/admin/payments', { token: S.admin })).total >= 4, 'payments');
    eq(ok(await call('GET', '/admin/commissions?kind=COMMISSION', { token: S.admin })).total, 5, 'ledger rows (3 + 1 + 1 reversal)');
    eq(ok(await call('GET', '/admin/payouts', { token: S.admin })).items[0].status, 'PAID', 'payouts');
    assert(ok(await call('GET', `/admin/bookings/${S.checkout.bookingId}`, { token: S.admin })).commissions.length === 3, 'booking detail');
  });
  await step('admin plot create/update/block + CSV import', async () => {
    const p = ok(await call('POST', '/admin/plots', { token: S.admin, body: { plotNo: 'P-999', block: 'Z', pricePaise: 500000000, lat: 18.5, lng: 73.8 } }), 201);
    eq(ok(await call('PUT', `/admin/plots/${p.id}`, { token: S.admin, body: { plotNo: 'P-999', pricePaise: 500000000, status: 'BLOCKED' } })).status, 'BLOCKED', 'block');
    eq((await call('PUT', `/admin/plots/${S.plots[0].id}`, { token: S.admin, body: { plotNo: 'P-001', pricePaise: 1, status: 'AVAILABLE' } })).body.code, 'PLOT_LOCKED', 'booked plot locked');
    const fd = new FormData();
    fd.append('file', new Blob(['plot_no,block,facing,area_sqft,price_paise,lat,lng\nP-001,A,East,1200,500000000,18.52,73.85\nP-002,A,West,1100,500000000,18.53,73.86\n'], { type: 'text/csv' }), 'p.csv');
    const r = await fetch(API + '/admin/plots/import', { method: 'POST', headers: { authorization: `Bearer ${S.admin}` }, body: fd });
    eq(r.status, 201, 'import');
    eq(sql(`select facing || '|' || status from plot where plot_no='P-001'`), 'East|BOOKED', 'import keeps status');
  });
  await step('admin tier update keeps existing booking snapshot', async () => {
    ok(await call('PUT', `/admin/tiers/${S.gold.id}`, { token: S.admin, body: { code: 'GOLD', name: 'Gold', amountPaise: 31000000, l1Bps: 2000, l2Bps: 1000, l3Bps: 1000, active: true, sort: 4 } }));
    eq(sql(`select amount_paise from booking where id='${S.checkout.bookingId}'`), '30000000', 'snapshot');
  });
  await step('admin config: valid set, invalid rejected, unknown 404; bookings pause works', async () => {
    eq((await call('PUT', '/admin/config/hold_minutes', { token: S.admin, body: { value: '999' } })).status, 400, 'invalid');
    eq((await call('PUT', '/admin/config/nope', { token: S.admin, body: { value: '1' } })).status, 404, 'unknown');
    ok(await call('PUT', '/admin/config/bookings_enabled', { token: S.admin, body: { value: 'false' } }));
    eq((await call('POST', '/bookings', { token: S.buyer, body: { plotId: S.plots[4].id, tierId: S.express.id, termsAccepted: true } })).body.code, 'BOOKINGS_PAUSED', 'paused');
    ok(await call('PUT', '/admin/config/bookings_enabled', { token: S.admin, body: { value: 'true' } }));
    assert(ok(await call('GET', '/admin/config', { token: S.admin })).length >= 10, 'config list');
  });
  await step('admin broadcast to partners', async () => {
    eq(ok(await call('POST', '/admin/notifications/broadcast', { token: S.admin, body: { audience: 'PARTNERS', title: 'Hi', body: 'Update' } }), 201).sent, 3, 'sent');
  });
  await step('admin suspend partner; partner endpoints blocked', async () => {
    ok(await call('POST', `/admin/users/${S.AId}/partner`, { token: S.admin, body: { action: 'SUSPEND' } }), 201);
    eq((await call('GET', '/commissions', { token: S.A })).status, 403, 'blocked');
    eq((await call('POST', `/admin/users/${S.AId}/partner`, { token: S.admin, body: { action: 'REJECT' } })).body.code, 'INVALID_STATE', 'bad transition');
  });
  await step('audit log recorded admin actions; jobs list', async () => {
    const a = ok(await call('GET', '/admin/audit?size=50', { token: S.admin }));
    const actions = new Set(a.items.map((i) => i.action));
    for (const x of ['PARTNER_APPROVE', 'LEDGER_APPROVE', 'PAYOUT_BATCH', 'BOOKING_CANCEL', 'DOCUMENT_UPLOAD', 'CONFIG_SET', 'PLOT_IMPORT', 'TIER_UPDATE', 'PARTNER_SUSPEND'])
      assert(actions.has(x), `missing audit ${x}`);
    ok(await call('GET', '/admin/jobs', { token: S.admin }));
  });
  await step('deactivated user: sessions revoked, refresh refused', async () => {
    ok(await call('POST', `/admin/users/${S.BId}/active`, { token: S.admin, body: { active: false } }), 201);
    eq((await call('POST', '/auth/refresh', { body: { refreshToken: S.BRefresh } })).status, 401, 'refresh');
  });

  // ---------- sessions ----------
  await step('refresh rotates; reuse of old token revokes all sessions', async () => {
    const r1 = ok(await call('POST', '/auth/refresh', { body: { refreshToken: S.buyerRefresh } }));
    eq((await call('POST', '/auth/refresh', { body: { refreshToken: S.buyerRefresh } })).body.code, 'TOKEN_REUSED', 'reuse');
    eq((await call('POST', '/auth/refresh', { body: { refreshToken: r1.refreshToken } })).status, 401, 'family revoked');
  });
  await step('logout revokes refresh token', async () => {
    const t = await login('9000000002');
    ok(await call('POST', '/auth/logout', { body: { refreshToken: t.refreshToken } }));
    eq((await call('POST', '/auth/refresh', { body: { refreshToken: t.refreshToken } })).status, 401, 'refresh after logout');
  });

  // ---------- invariants ----------
  await step('DB invariants: ledger reconciles, no double-booked plot, no failed jobs', async () => {
    eq(sql(`select count(*) from ledger_entry where gross_paise <> admin_paise + tds_paise + net_paise`), '0', 'ledger math');
    eq(sql(`select count(*) from (select plot_id from booking where status in ('PENDING_PAYMENT','CONFIRMED') group by plot_id having count(*)>1) x`), '0', 'double booking');
    eq(sql(`select count(*) from plot where status='BOOKED' and id not in (select plot_id from booking where status='CONFIRMED')`), '0', 'orphan BOOKED plot');
    eq(sql(`select count(*) from job where dead`), '0', 'dead jobs');
  });
  await step('no unhandled 500s in API log', async () => {
    const errors = readFileSync(LOG, 'utf8').split('\n').filter((l) => /ERROR/.test(l) && !/AMOUNT_MISMATCH/.test(l));
    assert(errors.length === 0, errors.slice(0, 3).join(' | '));
  });

  for (const [s, n] of results) console.log(`${s === 'PASS' ? '✅' : '❌'} ${n}`);
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
