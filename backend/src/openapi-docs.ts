/**
 * Human documentation for every endpoint, merged into the generated OpenAPI document.
 * Keyed by "METHOD /path" exactly as Nest exposes it. `enrichOpenApi` throws if a route is
 * missing here, so a new endpoint cannot ship undocumented (checked by `npm run openapi` and tests).
 */
import type { OpenAPIObject } from '@nestjs/swagger';

type ErrorCase = [status: number, code: string, message: string];

interface OpDoc {
  summary: string;
  description?: string;
  /** Adds page/size query parameters. */
  paged?: boolean;
  /** Example request body (JSON). */
  body?: unknown;
  /** Multipart upload: form fields (besides `file`) and what the file is. */
  multipart?: { file: string; fields?: Record<string, { description: string; example?: string; required?: boolean }> };
  /** Success status (default 200, or 201 for POST without override). */
  status?: number;
  ok: { description: string; example?: unknown };
  errors?: ErrorCase[];
  /** Extra query parameters the generator could not infer. */
  query?: Record<string, { description: string; schema: Record<string, unknown> }>;
  /** Public endpoint: no 401 added. */
  public?: boolean;
}

// ---------- shared examples ----------

const U1 = '6f1c2a8e-4b7d-4f0a-9a3c-2d5e8b1f0a11';
const U2 = '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PLOT = '3b8e6d1a-2c4f-4e9b-a1d7-5f0c8e2b9a33';
const TIER = 'b7a1c3e5-9d2f-4b6a-8e0c-1f3d5a7b9c22';
const BK = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e77';
const PAY = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f88';
const LE = 'e9f8a7b6-c5d4-4e3f-8a2b-1c0d9e8f7a66';
const DOC = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const NT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55';
const PO = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c44';
const TS = '2026-10-22T09:30:00.000Z';

const page = (items: unknown[], total = items.length) => ({ items, page: 0, size: 20, total });

const user = {
  id: U1, role: 'USER', mobile: '9876543210', email: 'asha@example.com', name: 'Asha Patil', address: 'Baner, Pune',
  partnerStatus: 'APPROVED', sponsorId: U2, leg: 'L', referralCode: 'P7KQ2XM', active: true, createdAt: TS,
};
const tokens = { accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2ZjFj…', refreshToken: 'q8V2c1sY9…', expiresIn: 900 };
const plot = { id: PLOT, plotNo: 'P-001', block: 'A', facing: 'East', areaSqft: 1200, pricePaise: 500000000, lat: 18.52, lng: 73.85, status: 'AVAILABLE' };
const tier = { id: TIER, code: 'GOLD', name: 'Gold', amountPaise: 30000000, l1Bps: 2000, l2Bps: 1000, l3Bps: 1000, benefits: null, active: true };
const checkout = {
  bookingId: BK, bookingRef: 'BK-2026-000123', paymentId: PAY, paymentRef: 'PAY-2026-000124', amountPaise: 30000000, currency: 'INR',
  razorpayOrderId: 'order_N8xQ2LkP3a', razorpayKeyId: 'rzp_live_AbC123', holdExpiresAt: '2026-10-22T09:45:00.000Z',
};
const bookingView = {
  id: BK, internalRef: 'BK-2026-000123', status: 'CONFIRMED', amountPaise: 30000000, holdExpiresAt: '2026-10-22T09:45:00.000Z', confirmedAt: TS, createdAt: TS,
  plot: { id: PLOT, plotNo: 'P-001', block: 'A', facing: 'East', areaSqft: 1200, lat: 18.52, lng: 73.85 },
  tier: { id: TIER, code: 'GOLD', name: 'Gold' },
};
const paymentStatus = {
  id: PAY, internalRef: 'PAY-2026-000124', status: 'VERIFIED', amountPaise: 30000000, providerPaymentId: 'pay_N8yR7mT2b', failureReason: null,
  verifiedAt: TS, createdAt: TS, bookingId: BK, bookingRef: 'BK-2026-000123', bookingStatus: 'CONFIRMED',
};
const ledger = {
  id: LE, kind: 'COMMISSION', level: 1, grossPaise: 6000000, adminPaise: 1200000, tdsPaise: 300000, netPaise: 4500000,
  status: 'APPROVED', statusAt: TS, reversesId: null, createdAt: TS, bookingRef: 'BK-2026-000123', plotNo: 'P-001', tierName: 'Gold',
};
const byStatus = [{ status: 'PENDING', count: 2, grossPaise: 9000000, adminPaise: 1800000, tdsPaise: 450000, netPaise: 6750000 }];
const notification = { id: NT, category: 'BOOKING', title: 'Booking confirmed', body: 'Plot P-001 is booked. Ref BK-2026-000123', deepLink: `booking/${BK}`, readAt: null, createdAt: TS };
const ok = { ok: true };

// ---------- request field descriptions (component schemas) ----------

const PLOT_UPDATE = { status: { description: 'Optional. AVAILABLE or BLOCKED (only when the plot is not held or booked)', example: 'BLOCKED' } };

export const FIELDS: Record<string, Record<string, { description: string; example?: unknown }>> = {
  RequestOtpDto: { mobile: { description: '10-digit Indian mobile number without +91, starting with 6–9', example: '9876543210' } },
  VerifyOtpDto: {
    mobile: { description: 'Same mobile the OTP was requested for', example: '9876543210' },
    code: { description: '6-digit code received by SMS (valid 5 minutes, 5 attempts)', example: '482913' },
    referralCode: { description: "Optional. Partner's referral code; applied only when this creates a new account", example: 'P7KQ2XM' },
    leg: { description: "Optional. Side of the sponsor's team (L or R). Omit to auto-balance", example: 'L' },
    deviceId: { description: 'Optional. Device identifier, stored with the refresh token', example: 'pixel-7-a1b2' },
  },
  GoogleDto: {
    idToken: { description: 'ID token from Google Sign-In on the device (requested with the Web client ID)', example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6…' },
    referralCode: { description: 'Optional. Applied only for a new account', example: 'P7KQ2XM' },
    leg: { description: 'Optional. L or R', example: 'R' },
    deviceId: { description: 'Optional. Device identifier', example: 'iphone-15-x9y8' },
  },
  RefreshDto: { refreshToken: { description: 'Refresh token from the last login or refresh', example: 'q8V2c1sY9…' } },
  UpdateProfileDto: {
    name: { description: 'Full name (required before booking)', example: 'Asha Patil' },
    email: { description: 'Optional. Must be unique across accounts', example: 'asha@example.com' },
    address: { description: 'Optional. Postal address', example: 'Baner, Pune 411045' },
  },
  NomineeDto: {
    name: { description: "Nominee's full name", example: 'Rahul Patil' },
    relation: { description: 'Relation to the customer', example: 'Spouse' },
    mobile: { description: "Optional. Nominee's 10-digit mobile", example: '9876500000' },
  },
  DeviceDto: {
    token: { description: 'Firebase Cloud Messaging registration token', example: 'fcm-token-dGhpc2lz…' },
    platform: { description: 'android or ios', example: 'android' },
  },
  SponsorDto: {
    referralCode: { description: "Approved partner's referral code", example: 'P7KQ2XM' },
    leg: { description: 'Optional. L or R; omit to auto-balance', example: 'L' },
  },
  LeadDto: {
    name: { description: "Prospect's name", example: 'Neha Shah' },
    mobile: { description: "Prospect's 10-digit mobile; links to you when they sign up", example: '9822000000' },
    note: { description: 'Optional. Private note', example: 'Met at site visit' },
  },
  CreateBookingDto: {
    plotId: { description: 'Plot to book (from GET /plots, must be AVAILABLE)', example: PLOT },
    tierId: { description: 'Booking plan (from GET /tiers)', example: TIER },
    termsAccepted: { description: 'Must be true: the customer accepted the booking terms', example: true },
  },
  VerifyPaymentDto: {
    razorpayOrderId: { description: 'razorpay_order_id from the Checkout success callback', example: 'order_N8xQ2LkP3a' },
    razorpayPaymentId: { description: 'razorpay_payment_id from the Checkout success callback', example: 'pay_N8yR7mT2b' },
    razorpaySignature: { description: 'razorpay_signature from the Checkout success callback', example: '9e1c4b7a2f…' },
  },
  BeneficiaryDto: {
    holderName: { description: 'Account holder name as per bank records', example: 'Asha Patil' },
    accountNumber: { description: 'Bank account number, 9–18 digits (stored encrypted)', example: '123456789012' },
    ifsc: { description: 'IFSC code, e.g. HDFC0001234', example: 'HDFC0001234' },
    pan: { description: 'PAN, required for TDS (stored encrypted)', example: 'ABCDE1234F' },
  },
  PlotDto: {
    plotNo: { description: 'Unique plot number', example: 'P-316' },
    block: { description: 'Optional. Block / sector', example: 'A' },
    facing: { description: 'Optional. Facing direction', example: 'East' },
    areaSqft: { description: 'Optional. Area in square feet', example: 1200 },
    pricePaise: { description: 'Plot price in paise (₹50,00,000 = 500000000)', example: 500000000 },
    lat: { description: 'Optional. Latitude for the map', example: 18.52 },
    lng: { description: 'Optional. Longitude for the map', example: 73.85 },
  },
  get PlotUpdateDto() { return { ...FIELDS.PlotDto, ...PLOT_UPDATE }; },
  TierDto: {
    code: { description: 'Unique plan code (stored upper-case)', example: 'GOLD' },
    name: { description: 'Display name', example: 'Gold' },
    amountPaise: { description: 'Booking amount in paise (₹3,00,000 = 30000000)', example: 30000000 },
    l1Bps: { description: 'Level-1 commission in basis points (2000 = 20%)', example: 2000 },
    l2Bps: { description: 'Level-2 commission in basis points', example: 1000 },
    l3Bps: { description: 'Level-3 commission in basis points', example: 1000 },
    benefits: { description: 'Optional. Benefits text shown to customers', example: 'Priority plot selection' },
    active: { description: 'Whether customers can choose this plan', example: true },
    sort: { description: 'Display order (ascending)', example: 4 },
  },
  PartnerActionDto: {
    action: { description: 'APPROVE, REJECT or SUSPEND', example: 'APPROVE' },
    note: { description: 'Optional. Shown to the user in the notification', example: 'Welcome aboard' },
  },
  ActiveDto: { active: { description: 'false deactivates the account and signs it out everywhere', example: false } },
  CancelDto: {
    refund: { description: 'true also refunds verified payments through Razorpay', example: true },
    reason: { description: 'Why the booking is cancelled (audit log)', example: 'Customer request' },
  },
  IdsDto: {
    ids: { description: 'Ledger entry IDs (max 500)', example: [LE] },
    note: { description: 'Optional. Stored in the status history', example: 'Verified with sales team' },
  },
  PayoutBatchDto: { userIds: { description: 'Optional. Pay only these partners; omit to pay everyone eligible', example: [U1] } },
  DocumentUploadDto: {
    userId: { description: 'Customer who will see the document', example: U1 },
    bookingId: { description: "Optional. Link to one of that customer's bookings", example: BK },
    type: { description: 'AGREEMENT, RECEIPT, ALLOTMENT or OTHER', example: 'AGREEMENT' },
    title: { description: 'Title shown in the document centre', example: 'Sale Agreement' },
  },
  DocumentStatusDto: { status: { description: 'PENDING, SENT, SIGNED, REJECTED or EXPIRED', example: 'SIGNED' } },
  BroadcastDto: {
    audience: { description: 'ALL users or only approved PARTNERS', example: 'PARTNERS' },
    title: { description: 'Notification title', example: 'New phase launched' },
    body: { description: 'Notification text', example: 'Phase 2 plots are now open for booking.' },
  },
  ConfigDto: { value: { description: 'New value (validated per key)', example: '15' } },
};

// ---------- endpoints ----------

const v400: ErrorCase = [400, 'VALIDATION_FAILED', 'mobile: mobile must be a valid 10-digit Indian number'];
const notPartner: ErrorCase = [403, 'PARTNER_NOT_APPROVED', 'Partner approval is required'];
const nf = (what: string): ErrorCase => [404, 'NOT_FOUND', `${what} not found`];

export const OPS: Record<string, OpDoc> = {
  'GET /health': { public: true, summary: 'Health check', description: 'Returns ok when the API and its database are reachable. Use for load balancer and uptime checks.', ok: { description: 'Healthy', example: { status: 'ok' } }, errors: [[500, 'INTERNAL', 'Something went wrong']] },

  // Auth
  'POST /auth/otp/request': {
    public: true, status: 200, summary: 'Send login OTP',
    description: 'Sends a 6-digit OTP by SMS. The code is valid for 5 minutes. Limits: 3 requests per mobile per 15 minutes, 30 per IP per minute.',
    body: { mobile: '9876543210' }, ok: { description: 'OTP sent', example: { expiresInSec: 300, resendAfterSec: 30 } },
    errors: [v400, [429, 'OTP_RATE_LIMITED', 'Too many OTP requests, try again in 15 minutes']],
  },
  'POST /auth/otp/verify': {
    public: true, status: 200, summary: 'Verify OTP and sign in',
    description: 'Checks the OTP and returns tokens. Creates the account on first login (optionally under a referral code). `profileComplete: false` means send the user to the profile screen before booking.',
    body: { mobile: '9876543210', code: '482913', referralCode: 'P7KQ2XM', deviceId: 'pixel-7-a1b2' },
    ok: { description: 'Signed in', example: { ...tokens, isNewUser: true, profileComplete: false } },
    errors: [[400, 'OTP_INVALID', 'Incorrect OTP'], [400, 'OTP_EXPIRED', 'OTP expired, request a new one'], [400, 'INVALID_REFERRAL', 'Referral code is invalid'], [403, 'ACCOUNT_DISABLED', 'Account is disabled'], [429, 'OTP_LOCKED', 'Too many attempts, request a new OTP']],
  },
  'POST /auth/google': {
    public: true, status: 200, summary: 'Sign in with Google',
    description: "Verifies a Google ID token (verified email required) and returns tokens. Links to an existing account with the same email. Returns 501 if Google sign-in isn't configured.",
    body: { idToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6…', referralCode: 'P7KQ2XM' },
    ok: { description: 'Signed in', example: { ...tokens, isNewUser: false, profileComplete: true } },
    errors: [[401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in failed'], [401, 'GOOGLE_EMAIL_UNVERIFIED', 'Google email is not verified'], [501, 'NOT_CONFIGURED', 'Google sign-in is not configured']],
  },
  'POST /auth/refresh': {
    public: true, status: 200, summary: 'Refresh tokens',
    description: 'Exchanges a refresh token for a new access + refresh token pair; the old refresh token stops working. Run one refresh at a time: reusing an old refresh token signs the user out on every device.',
    body: { refreshToken: 'q8V2c1sY9…' }, ok: { description: 'New tokens', example: tokens },
    errors: [[401, 'TOKEN_INVALID', 'Session expired'], [401, 'TOKEN_REUSED', 'Session revoked, please sign in again'], [403, 'ACCOUNT_DISABLED', 'Account is disabled']],
  },
  'POST /auth/logout': { public: true, status: 200, summary: 'Log out this device', description: 'Revokes the given refresh token.', body: { refreshToken: 'q8V2c1sY9…' }, ok: { description: 'Logged out', example: ok } },

  // Profile
  'GET /me/bootstrap': {
    summary: 'Splash-screen data',
    description: 'Everything the app needs at launch: user, whether the profile is complete, minimum app version, whether bookings are open, support contacts. Route: 401 → login; old app → force update; profileComplete false → profile; role ADMIN → admin panel.',
    ok: { description: 'Bootstrap data', example: { user, profileComplete: true, minAppVersion: '1.0.0', bookingsEnabled: true, support: { phone: '+91 20 0000 0000', email: 'support@315plots.app' } } },
  },
  'GET /me': { summary: 'My profile', description: 'Profile with nominee.', ok: { description: 'Profile', example: { ...user, nominee: { name: 'Rahul Patil', relation: 'Spouse', mobile: '9876500000' } } } },
  'PUT /me': {
    summary: 'Update my profile', description: 'Name is required before booking. Email must be unique.',
    body: { name: 'Asha Patil', email: 'asha@example.com', address: 'Baner, Pune 411045' },
    ok: { description: 'Updated profile', example: { ...user, nominee: null } }, errors: [[409, 'CONFLICT', 'Already exists or state changed, refresh and retry']],
  },
  'PUT /me/nominee': { summary: 'Set nominee', body: { name: 'Rahul Patil', relation: 'Spouse', mobile: '9876500000' }, ok: { description: 'Updated profile', example: { ...user, nominee: { name: 'Rahul Patil', relation: 'Spouse', mobile: '9876500000' } } } },
  'POST /me/devices': {
    summary: 'Register push token', description: 'Call after every login and whenever Firebase rotates the token. Push notifications go to every registered device.',
    body: { token: 'fcm-token-dGhpc2lz…', platform: 'android' }, ok: { description: 'Registered', example: ok },
  },
  'PUT /me/sponsor': {
    summary: 'Add a referral code later', description: 'For users who signed up without a code. Not allowed once a sponsor is set or after the first booking.',
    body: { referralCode: 'P7KQ2XM', leg: 'L' }, ok: { description: 'Updated profile', example: user },
    errors: [[400, 'INVALID_REFERRAL', 'Referral code is invalid'], [400, 'INVALID_SPONSOR', 'Sponsor is in your own network'], [409, 'SPONSOR_LOCKED', 'Sponsor cannot change after a booking'], [409, 'SPONSOR_ALREADY_SET', 'Sponsor is already set']],
  },

  // Partner
  'POST /partners/apply': {
    status: 201, summary: 'Apply to become a partner', description: 'Moves partnerStatus NONE/REJECTED → PENDING. An admin approves or rejects; the user is notified.',
    ok: { description: 'Application submitted', example: { partnerStatus: 'PENDING' } },
    errors: [[400, 'PROFILE_INCOMPLETE', 'Complete your profile first'], [409, 'INVALID_STATE', 'Partner status is APPROVED']],
  },
  'GET /partners/me': {
    summary: 'My partner status and referral link', description: 'referralCode and referralLink are null until approved. directLeft/directRight count direct recruits per leg.',
    ok: { description: 'Partner info', example: { partnerStatus: 'APPROVED', referralCode: 'P7KQ2XM', referralLink: 'https://315plots.app/r/P7KQ2XM', directLeft: 4, directRight: 2 } },
  },
  'GET /partners/network': {
    paged: true, query: { level: { description: 'Team level: 0 = all three, or 1, 2, 3', schema: { type: 'integer', minimum: 0, maximum: 3, default: 0 } } }, summary: 'My team (3 levels)', description: 'Members below me. Query `level` 0 = all three levels, or 1/2/3. `side` is which of my two legs the member is in. Mobiles are masked.',
    ok: { description: 'Team members', example: page([{ id: U2, name: 'Vikram', mobile: '******3210', partnerStatus: 'APPROVED', createdAt: TS, side: 'L', level: 1, hasBooking: true }], 9) },
    errors: [notPartner],
  },
  'POST /leads': {
    summary: 'Register a lead', description: 'Records a prospect. When that mobile signs up without a referral code, you become their sponsor automatically.',
    body: { name: 'Neha Shah', mobile: '9822000000', note: 'Met at site visit' },
    ok: { description: 'Lead created', example: { id: NT, partnerId: U1, name: 'Neha Shah', mobile: '9822000000', note: 'Met at site visit', convertedUserId: null, createdAt: TS } },
    errors: [notPartner, [409, 'ALREADY_REGISTERED', 'This mobile number already has an account']],
  },
  'GET /leads': {
    paged: true, summary: 'My leads', description: 'Status: NEW (not signed up), REGISTERED (signed up), BOOKED (has a confirmed booking).',
    ok: { description: 'Leads', example: page([{ id: NT, name: 'Neha Shah', mobile: '9822000000', note: 'Met at site visit', createdAt: TS, status: 'REGISTERED' }]) },
    errors: [notPartner],
  },

  // Plots
  'GET /plots': {
    paged: true, summary: 'List plots', description: 'Filter by status (AVAILABLE, HELD, BOOKED, BLOCKED), block and facing. `summary` gives the count per status for the whole project. Use lat/lng for map pins. Only AVAILABLE plots can be booked.',
    ok: { description: 'Plots', example: { ...page([plot], 312), summary: [{ status: 'AVAILABLE', count: 312 }, { status: 'BOOKED', count: 3 }] } },
  },
  'GET /plots/{id}': { summary: 'Plot details', ok: { description: 'Plot', example: plot }, errors: [nf('Plot')] },
  'GET /tiers': {
    summary: 'Booking plans', description: 'Active plans in display order. Always show prices from here. Commission rates are basis points (2000 = 20%).',
    ok: {
      description: 'Plans',
      example: [
        { ...tier, id: TIER, code: 'EXPRESS', name: 'Express Token', amountPaise: 2100000, l1Bps: 1000, l2Bps: 500, l3Bps: 500 },
        tier,
      ],
    },
  },

  // Bookings
  'POST /bookings': {
    summary: 'Book a plot (start checkout)',
    description: 'Holds the plot for 15 minutes and creates a Razorpay order. Open Razorpay Checkout with razorpayKeyId, razorpayOrderId and amountPaise, then call POST /payments/verify. The booking becomes CONFIRMED only after the server verifies the payment.',
    body: { plotId: PLOT, tierId: TIER, termsAccepted: true }, ok: { description: 'Checkout started', example: checkout },
    errors: [
      [400, 'PROFILE_INCOMPLETE', 'Complete your profile before booking'], nf('Plot'),
      [409, 'PLOT_UNAVAILABLE', 'This plot is no longer available'], [409, 'PENDING_BOOKING_EXISTS', 'Finish or cancel your current checkout first'],
      [502, 'PROVIDER_ERROR', 'Could not start payment, please retry'], [503, 'BOOKINGS_PAUSED', 'Bookings are paused, try later'],
    ],
  },
  'GET /bookings': { paged: true, summary: 'My bookings', ok: { description: 'Bookings', example: page([bookingView]) } },
  'GET /bookings/{id}': {
    summary: 'Booking details', description: 'Status: PENDING_PAYMENT, CONFIRMED, EXPIRED, CANCELLED, REFUND_PENDING, REFUNDED. Poll this after payment until CONFIRMED.',
    ok: {
      description: 'Booking',
      example: {
        ...bookingView,
        payments: [{ id: PAY, internalRef: 'PAY-2026-000124', amountPaise: 30000000, status: 'VERIFIED', providerOrderId: 'order_N8xQ2LkP3a', providerPaymentId: 'pay_N8yR7mT2b', failureReason: null, verifiedAt: TS, createdAt: TS }],
        documents: [{ id: DOC, type: 'AGREEMENT', title: 'Sale Agreement', status: 'SENT', createdAt: TS }],
      },
    },
    errors: [nf('Booking')],
  },
  'POST /bookings/{id}/retry-payment': {
    summary: 'Retry payment', description: 'New Razorpay order for an unpaid booking while its hold is still live.',
    ok: { description: 'New checkout', example: checkout },
    errors: [nf('Booking'), [409, 'HOLD_EXPIRED', 'This booking can no longer be paid, start a new one'], [502, 'PROVIDER_ERROR', 'Could not start payment, please retry']],
  },

  // Payments
  'POST /payments/verify': {
    status: 200, summary: 'Confirm payment after Checkout',
    description: 'Send the three values from the Razorpay Checkout success callback. The server checks the signature and asks Razorpay for the real status. If bookingStatus is still PENDING_PAYMENT, poll GET /bookings/{id}.',
    body: { razorpayOrderId: 'order_N8xQ2LkP3a', razorpayPaymentId: 'pay_N8yR7mT2b', razorpaySignature: '9e1c4b7a2f…' },
    ok: { description: 'Payment status', example: paymentStatus },
    errors: [[400, 'SIGNATURE_INVALID', 'Payment signature is invalid'], nf('Payment')],
  },
  'GET /payments': { paged: true, summary: 'My payments', ok: { description: 'Payments', example: page([{ id: PAY, internalRef: 'PAY-2026-000124', amountPaise: 30000000, status: 'VERIFIED', providerPaymentId: 'pay_N8yR7mT2b', failureReason: null, verifiedAt: TS, createdAt: TS, bookingRef: 'BK-2026-000123', plotNo: 'P-001' }]) } },
  'GET /payments/{id}': { summary: 'Payment status', description: 'Status: CREATED, PENDING, VERIFIED, FAILED, REFUND_PENDING, REFUNDED.', ok: { description: 'Payment', example: paymentStatus }, errors: [nf('Payment')] },
  'GET /payments/{id}/receipt': {
    summary: 'Payment receipt', description: 'Receipt data for a verified payment; the app renders and shares it.',
    ok: { description: 'Receipt', example: { receiptNo: 'PAY-2026-000124', amountPaise: 30000000, providerPaymentId: 'pay_N8yR7mT2b', verifiedAt: TS, bookingRef: 'BK-2026-000123', plotNo: 'P-001', tierName: 'Gold', customerName: 'Asha Patil', mobile: '9876543210', email: 'asha@example.com' } },
    errors: [nf('Receipt')],
  },

  // Webhooks
  'POST /webhooks/razorpay': {
    public: true, status: 200, summary: 'Razorpay webhook (server-to-server)',
    description: 'Called by Razorpay, never by the app. Body is the raw Razorpay event; the X-Razorpay-Signature header must be the HMAC-SHA256 of the raw body with the webhook secret. Handles payment.captured, payment.failed, refund.processed. Repeated events are accepted and ignored.',
    body: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_N8yR7mT2b', order_id: 'order_N8xQ2LkP3a', amount: 30000000, status: 'captured' } } } },
    ok: { description: 'Event stored and applied', example: ok }, errors: [[401, 'SIGNATURE_INVALID', 'Invalid signature']],
  },
  'POST /webhooks/cashfree': {
    public: true, status: 200, summary: 'Cashfree Payouts webhook (server-to-server)',
    description: 'Called by Cashfree. x-webhook-signature = base64 HMAC-SHA256 of (x-webhook-timestamp + raw body) with the client secret. Handles TRANSFER_SUCCESS, TRANSFER_FAILED, TRANSFER_REJECTED, TRANSFER_REVERSED.',
    body: { type: 'TRANSFER_SUCCESS', data: { transfer_id: 'PO-2026-000210' } },
    ok: { description: 'Event stored and applied', example: ok }, errors: [[401, 'SIGNATURE_INVALID', 'Invalid signature']],
  },

  // Earnings
  'GET /commissions/summary': { summary: 'Commission totals', description: 'Totals per status, each split into gross, 20% admin, 5% TDS and net.', ok: { description: 'Summary', example: { byStatus } }, errors: [notPartner] },
  'GET /commissions': {
    paged: true, summary: 'Commission ledger',
    description: 'My ledger entries, newest first. kind COMMISSION (default) or MATCHING. Status flow: PENDING → ELIGIBLE (after 7 days) → APPROVED (admin) → PAID; ON_HOLD and REVERSED possible. Negative amounts are reversals of cancelled bookings.',
    ok: { description: 'Entries', example: page([ledger]) }, errors: [notPartner],
  },
  'GET /commissions/{id}': {
    summary: 'Commission entry details', description: 'One entry with booking context and its full status history.',
    ok: { description: 'Entry', example: { ...ledger, userId: U1, sourceBookingId: BK, buyerName: 'Rohan Mehta', history: [{ status: 'PENDING', note: null, createdAt: TS }, { status: 'ELIGIBLE', note: 'Cooling period complete', createdAt: TS }, { status: 'APPROVED', note: null, createdAt: TS }] } },
    errors: [nf('Ledger entry')],
  },
  'GET /matching/summary': {
    summary: '70:30 matching summary', description: 'Business volume on each leg, unmatched carry-forward, the stronger (power) leg and matching bonus totals.',
    ok: { description: 'Matching', example: { leftVolumePaise: 30000000, rightVolumePaise: 7100000, carryLeftPaise: 30000000, carryRightPaise: 7100000, powerLeg: 'L', byStatus } },
    errors: [notPartner],
  },
  'GET /matching/runs': { paged: true, summary: 'Matching history', description: 'One row per daily matching run that paid a bonus.', ok: { description: 'Runs', example: page([{ id: NT, userId: U1, leftUsed: 700000, rightUsed: 300000, matchedPaise: 1000000, bonusPaise: 500000, createdAt: TS }]) }, errors: [notPartner] },

  // Payouts
  'GET /payouts/beneficiary': { summary: 'My bank details (masked)', description: 'Empty object if none saved.', ok: { description: 'Beneficiary', example: { holderName: 'Asha Patil', accountMasked: '****9012', ifsc: 'HDFC0001234', panMasked: '******234F', status: 'VERIFIED', updatedAt: TS } } },
  'PUT /payouts/beneficiary': {
    summary: 'Save bank details', description: 'Registers the account with Cashfree. Account number and PAN are stored encrypted and only returned masked.',
    body: { holderName: 'Asha Patil', accountNumber: '123456789012', ifsc: 'HDFC0001234', pan: 'ABCDE1234F' },
    ok: { description: 'Saved (masked)', example: { holderName: 'Asha Patil', accountMasked: '****9012', ifsc: 'HDFC0001234', panMasked: '******234F', status: 'VERIFIED', updatedAt: TS } },
    errors: [notPartner, [502, 'PROVIDER_ERROR', 'Payout provider error']],
  },
  'GET /payouts': {
    paged: true, summary: 'My payouts', description: 'Payout history plus availablePaise: approved net amount waiting for the next payout. Status: REQUESTED → PROCESSING → PAID or FAILED.',
    ok: { description: 'Payouts', example: { ...page([{ id: PO, internalRef: 'PO-2026-000210', amountPaise: 4500000, status: 'PAID', providerTransferId: 'cf_1029384', failureReason: null, createdAt: TS, updatedAt: TS }]), availablePaise: 0 } },
    errors: [notPartner],
  },

  // Documents
  'GET /documents': { paged: true, summary: 'My documents', description: 'Type: AGREEMENT, RECEIPT, ALLOTMENT, OTHER. Status: PENDING, SENT, SIGNED, REJECTED, EXPIRED.', ok: { description: 'Documents', example: page([{ id: DOC, type: 'AGREEMENT', title: 'Sale Agreement', status: 'SENT', createdAt: TS, updatedAt: TS, bookingRef: 'BK-2026-000123' }]) } },
  'GET /documents/{id}/url': { summary: 'Download link', description: 'A private link valid for 5 minutes. Request a new one every time; never cache it.', ok: { description: 'Signed URL', example: { url: 'https://plots315-docs.s3.ap-south-1.amazonaws.com/documents/…?X-Amz-Signature=…', expiresInSec: 300 } }, errors: [nf('Document')] },
  'POST /documents/{id}/sign': { status: 200, summary: 'Sign a document (eSign)', description: 'Reserved for eSign. Until a provider is connected this always returns 501 ESIGN_NOT_CONFIGURED; admins set the status with PATCH /admin/documents/{id}/status.', ok: { description: 'Signing session (when eSign is connected)' }, errors: [[501, 'ESIGN_NOT_CONFIGURED', 'Online signing is not available yet']] },

  // Notifications
  'GET /notifications': {
    paged: true, summary: 'Notification inbox', description: 'Newest first, with the unread count. deepLink: booking/{id}, payment/{id}, document/{id}, commission, matching, payout/{id}, partner.',
    ok: { description: 'Notifications', example: { ...page([notification], 12), unread: 3 } },
  },
  'POST /notifications/{id}/read': { status: 201, summary: 'Mark one as read', ok: { description: 'Marked', example: ok }, errors: [nf('Notification')] },
  'POST /notifications/read-all': { status: 201, summary: 'Mark all as read', ok: { description: 'Marked', example: ok } },

  // Admin
  'GET /admin/dashboard': {
    summary: 'Admin dashboard', description: 'Plots by status, confirmed sales by plan, partner counts, ledger totals by status, payout totals by status.',
    ok: { description: 'Dashboard', example: { plots: [{ status: 'AVAILABLE', count: 312 }, { status: 'BOOKED', count: 3 }], bookings: [{ tier: 'Gold', count: 3, amountPaise: 90000000 }], partners: { pending: 2, approved: 14 }, ledger: [{ status: 'APPROVED', count: 5, netPaise: 15750000 }], payouts: [{ status: 'PAID', count: 4, amountPaise: 12000000 }] } },
  },
  'GET /admin/plots': { paged: true, summary: 'All plots', description: 'Same filters as GET /plots.', ok: { description: 'Plots', example: { ...page([plot], 315), summary: [{ status: 'AVAILABLE', count: 315 }] } } },
  'POST /admin/plots': { summary: 'Add a plot', body: { plotNo: 'P-316', block: 'D', facing: 'North', areaSqft: 1500, pricePaise: 500000000, lat: 18.53, lng: 73.86 }, ok: { description: 'Created plot (raw row)', example: { ...plot, plotNo: 'P-316', heldUntil: null, createdAt: TS, updatedAt: TS } }, errors: [[409, 'CONFLICT', 'Already exists or state changed, refresh and retry']] },
  'PUT /admin/plots/{id}': {
    summary: 'Edit or block a plot', description: 'Status may only change between AVAILABLE and BLOCKED; held or booked plots keep their status.',
    body: { plotNo: 'P-001', block: 'A', facing: 'East', areaSqft: 1200, pricePaise: 500000000, lat: 18.52, lng: 73.85, status: 'BLOCKED' },
    ok: { description: 'Updated plot', example: { ...plot, status: 'BLOCKED', heldUntil: null, createdAt: TS, updatedAt: TS } },
    errors: [nf('Plot'), [409, 'PLOT_LOCKED', 'Plot is BOOKED; status cannot be changed']],
  },
  'POST /admin/plots/import': {
    summary: 'Import plots from CSV',
    description: 'Upserts plots by plot_no. Header must be exactly `plot_no,block,facing,area_sqft,price_paise,lat,lng`. Never changes a plot status. Max 2 MB.',
    multipart: { file: 'CSV file' }, ok: { description: 'Imported', example: { imported: 315 } },
    errors: [[400, 'BAD_CSV', 'Header must be plot_no,block,facing,area_sqft,price_paise,lat,lng'], [400, 'FILE_REQUIRED', 'CSV file is required']],
  },
  'GET /admin/tiers': { summary: 'All plans (incl. inactive)', ok: { description: 'Plans', example: [tier] } },
  'POST /admin/tiers': { summary: 'Create a plan', body: { code: 'DIAMOND', name: 'Diamond', amountPaise: 100000000, l1Bps: 2500, l2Bps: 1500, l3Bps: 1000, benefits: 'Corner plot priority', active: true, sort: 6 }, ok: { description: 'Created plan', example: { ...tier, code: 'DIAMOND', name: 'Diamond', amountPaise: 100000000, sort: 6 } } },
  'PUT /admin/tiers/{id}': { summary: 'Edit a plan', description: 'Existing bookings keep the price and commission rates they were booked at.', body: { code: 'GOLD', name: 'Gold', amountPaise: 31000000, l1Bps: 2000, l2Bps: 1000, l3Bps: 1000, benefits: 'Priority plot selection', active: true, sort: 4 }, ok: { description: 'Updated plan', example: { ...tier, amountPaise: 31000000, sort: 4 } }, errors: [nf('Plan')] },
  'GET /admin/users': { paged: true, summary: 'Search users', description: 'search matches name, mobile, email or referral code. Filters: role, partnerStatus.', ok: { description: 'Users', example: page([{ id: U1, role: 'USER', mobile: '9876543210', email: 'asha@example.com', name: 'Asha Patil', partnerStatus: 'PENDING', referralCode: null, sponsorId: U2, leg: 'L', active: true, createdAt: TS }]) } },
  'GET /admin/users/{id}': { summary: 'User details', description: 'Profile, bookings, ledger totals and masked bank details.', ok: { description: 'User', example: { user, bookings: [bookingView], ledger: [{ kind: 'COMMISSION', status: 'APPROVED', count: 2, netPaise: 6750000 }], beneficiary: null } }, errors: [nf('User')] },
  'POST /admin/users/{id}/partner': {
    summary: 'Approve / reject / suspend a partner', description: 'APPROVE (from PENDING, REJECTED or SUSPENDED) creates the referral code. REJECT only from PENDING. SUSPEND only from APPROVED. The user is notified.',
    body: { action: 'APPROVE', note: 'Welcome aboard' }, ok: { description: 'New status', example: { partnerStatus: 'APPROVED', referralCode: 'P7KQ2XM' } },
    errors: [nf('User'), [409, 'INVALID_STATE', 'Cannot reject a APPROVED partner']],
  },
  'POST /admin/users/{id}/active': { summary: 'Activate / deactivate a user', description: 'Deactivating signs the user out of every device.', body: { active: false }, ok: { description: 'New state', example: { active: false } }, errors: [nf('User'), [400, 'SELF', 'You cannot deactivate yourself']] },
  'GET /admin/bookings': { paged: true, summary: 'All bookings', description: 'Filters: status, userId.', ok: { description: 'Bookings', example: page([{ id: BK, internalRef: 'BK-2026-000123', status: 'CONFIRMED', amountPaise: 30000000, createdAt: TS, confirmedAt: TS, plotNo: 'P-001', tierName: 'Gold', customerName: 'Asha Patil', mobile: '9876543210' }]) } },
  'GET /admin/bookings/{id}': { summary: 'Booking details (admin)', description: 'Booking with all payments and the commission entries it created.', ok: { description: 'Booking', example: { ...bookingView, payments: [{ id: PAY, status: 'VERIFIED', amountPaise: 30000000 }], commissions: [{ ...ledger, beneficiaryName: 'Vikram' }] } }, errors: [nf('Booking')] },
  'POST /admin/bookings/{id}/cancel': {
    summary: 'Cancel a booking', description: 'Frees the plot and reverses every commission from it. With refund true, verified payments are refunded through Razorpay. Already-paid commission is deducted from the next payout.',
    body: { refund: true, reason: 'Customer request' }, ok: { description: 'Cancelled', example: ok },
    errors: [nf('Booking'), [409, 'INVALID_STATE', 'Booking is REFUNDED']],
  },
  'GET /admin/payments': { paged: true, summary: 'All payments', description: 'Filters: status, userId.', ok: { description: 'Payments', example: page([{ id: PAY, internalRef: 'PAY-2026-000124', bookingId: BK, userId: U1, amountPaise: 30000000, status: 'VERIFIED', provider: 'razorpay', providerOrderId: 'order_N8xQ2LkP3a', providerPaymentId: 'pay_N8yR7mT2b', customerName: 'Asha Patil', bookingRef: 'BK-2026-000123', createdAt: TS }]) } },
  'GET /admin/commissions': { paged: true, summary: 'All ledger entries', description: 'Filters: status, kind (COMMISSION, MATCHING), userId.', ok: { description: 'Entries', example: page([{ ...ledger, userId: U1, beneficiaryName: 'Asha Patil' }]) } },
  'POST /admin/commissions/approve': { status: 201, summary: 'Approve commission', description: 'ELIGIBLE → APPROVED. Entries in any other status are skipped (see `changed`).', body: { ids: [LE], note: 'Verified' }, ok: { description: 'Result', example: { requested: 1, changed: 1 } } },
  'POST /admin/commissions/hold': { status: 201, summary: 'Put commission on hold', description: 'PENDING / ELIGIBLE / APPROVED → ON_HOLD. Entries already in a payout are skipped.', body: { ids: [LE], note: 'Under review' }, ok: { description: 'Result', example: { requested: 1, changed: 1 } } },
  'POST /admin/commissions/release': { status: 201, summary: 'Release held commission', description: 'ON_HOLD → ELIGIBLE.', body: { ids: [LE] }, ok: { description: 'Result', example: { requested: 1, changed: 1 } } },
  'GET /admin/payouts': { paged: true, summary: 'All payouts', description: 'Filters: status, userId.', ok: { description: 'Payouts', example: page([{ id: PO, internalRef: 'PO-2026-000210', userId: U1, amountPaise: 4500000, status: 'PROCESSING', providerTransferId: 'cf_1029384', partnerName: 'Asha Patil', createdAt: TS }]) } },
  'POST /admin/payouts': {
    status: 201, summary: 'Run a payout batch', description: 'Pays every partner (or only userIds) whose approved net amount is at least the configured minimum and who has verified bank details. Each becomes a Cashfree transfer.',
    body: { userIds: [U1] }, ok: { description: 'Batch result', example: { created: 1, results: [{ userId: U1, payoutRef: 'PO-2026-000210', amountPaise: 4500000, status: 'PROCESSING' }] } },
  },
  'POST /admin/documents': {
    summary: 'Upload a document for a customer', description: 'PDF, JPEG or PNG up to 10 MB. Stored privately; the customer is notified. Status starts as SENT.',
    multipart: {
      file: 'The document (PDF/JPEG/PNG)',
      fields: {
        userId: { description: 'Customer ID', example: U1, required: true },
        bookingId: { description: 'Optional booking ID of that customer', example: BK },
        type: { description: 'AGREEMENT, RECEIPT, ALLOTMENT or OTHER', example: 'AGREEMENT', required: true },
        title: { description: 'Title shown to the customer', example: 'Sale Agreement', required: true },
      },
    },
    ok: { description: 'Uploaded', example: { id: DOC, userId: U1, bookingId: BK, type: 'AGREEMENT', title: 'Sale Agreement', status: 'SENT', createdAt: TS } },
    errors: [[400, 'FILE_REQUIRED', 'File is required'], [400, 'FILE_TYPE', 'Only PDF, JPEG or PNG'], [400, 'BOOKING_MISMATCH', 'Booking does not belong to this user'], nf('User')],
  },
  'PATCH /admin/documents/{id}/status': { summary: 'Set document status', description: 'Used until an eSign provider is connected. The customer is notified.', body: { status: 'SIGNED' }, ok: { description: 'New status', example: { status: 'SIGNED' } }, errors: [nf('Document')] },
  'POST /admin/notifications/broadcast': { status: 201, summary: 'Broadcast a notification', body: { audience: 'PARTNERS', title: 'New phase launched', body: 'Phase 2 plots are now open for booking.' }, ok: { description: 'Number of users notified', example: { sent: 14 } } },
  'GET /admin/config': { summary: 'Business settings', ok: { description: 'Settings', example: [{ key: 'bookings_enabled', value: 'true' }, { key: 'hold_minutes', value: '15' }, { key: 'cooling_days', value: '7' }, { key: 'min_payout_paise', value: '10000' }] } },
  'PUT /admin/config/{key}': {
    summary: 'Change a business setting',
    description: 'Keys: bookings_enabled (true/false), hold_minutes (5–60), cooling_days (0–90), min_payout_paise, admin_bps, tds_bps, matching_power_pct, matching_weak_pct, matching_bonus_bps, min_app_version (x.y.z), support_phone, support_email.',
    body: { value: '15' }, ok: { description: 'Saved', example: { key: 'hold_minutes', value: '15' } },
    errors: [[400, 'INVALID_VALUE', 'Invalid value for hold_minutes'], nf('Config key')],
  },
  'GET /admin/audit': { paged: true, summary: 'Audit log', description: 'Every admin change with before/after values. Filters: entity (plot, tier, user, booking, ledger_entry, payout, document, app_config), entityId.', ok: { description: 'Audit entries', example: page([{ id: 1042, actorId: U2, actorName: 'Admin', action: 'PARTNER_APPROVE', entity: 'user', entityId: U1, before: { partnerStatus: 'PENDING' }, after: { partnerStatus: 'APPROVED' }, createdAt: TS }]) } },
  'GET /admin/jobs': { paged: true, summary: 'Background jobs', description: 'Queued work (push notifications, refunds). dead=true lists jobs that failed 8 times.', ok: { description: 'Jobs', example: page([{ id: 88, type: 'PUSH', payload: { id: NT }, runAt: TS, attempts: 8, lastError: 'messaging/invalid-argument', doneAt: TS, dead: true }]) } },
  'POST /admin/jobs/{id}/retry': { status: 201, summary: 'Retry a failed job', ok: { description: 'Requeued', example: ok }, errors: [nf('Dead job')] },
};

const TAGS = [
  { name: 'Auth', description: 'Sign in with mobile OTP or Google, refresh and revoke tokens.' },
  { name: 'Profile', description: "The signed-in user's profile, nominee, push token and sponsor." },
  { name: 'Partner', description: 'Referral programme: apply, referral link, team, leads. Requires partner approval except apply.' },
  { name: 'Plots', description: 'Plot inventory and booking plans.' },
  { name: 'Bookings', description: 'Hold a plot and pay through Razorpay.' },
  { name: 'Payments', description: 'Payment verification, history and receipts.' },
  { name: 'Earnings', description: 'Commission ledger and 70:30 matching (partners).' },
  { name: 'Payouts', description: 'Bank details and commission payouts (partners).' },
  { name: 'Documents', description: 'Agreements and receipts shared with the customer.' },
  { name: 'Notifications', description: 'In-app inbox; the same items arrive as push notifications.' },
  { name: 'Admin', description: 'Operations for ADMIN accounts only. Every change is audit-logged.' },
  { name: 'Webhooks', description: 'Server-to-server callbacks from Razorpay and Cashfree. Not for the app.' },
  { name: 'System', description: 'Health check.' },
];

const DESCRIPTION = `Backend for the 315 PLOTS mobile app.

**Roles** — \`USER\` (every customer; becomes a partner after admin approval) and \`ADMIN\` (operations, \`/admin/*\`).

**Try it here**
1. \`POST /auth/otp/request\` with your mobile.
2. \`POST /auth/otp/verify\` with the code (in staging the code is in the server logs).
3. Click **Authorize** and paste \`accessToken\`.

**Conventions**
- Money is **integer paise**: \`amountPaise: 2100000\` = ₹21,000. Display ₹ = paise ÷ 100.
- Lists take \`page\` (from 0) and \`size\` (1–50) and return \`{ items, page, size, total }\`.
- Every error is \`{ code, message, requestId }\` — branch on \`code\`.
- Access tokens last 15 minutes; refresh with \`POST /auth/refresh\` (one refresh at a time).
- Dates are ISO-8601 UTC.`;

const errorSchema = {
  type: 'object',
  required: ['code', 'message', 'requestId'],
  properties: {
    code: { type: 'string', description: 'Stable machine-readable error code', example: 'PLOT_UNAVAILABLE' },
    message: { type: 'string', description: 'Human-readable message to show the user', example: 'This plot is no longer available' },
    requestId: { type: 'string', description: 'Correlates with server logs (also in the X-Request-Id header)', example: '3f0c9b2e-1a4d-4c8b-9e7f-2d1a6b5c4e30' },
  },
};

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request', 500: 'Server error', 401: 'Not signed in or token expired', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict (state changed)',
  429: 'Too many requests', 501: 'Not configured', 502: 'Payment/payout provider error', 503: 'Temporarily unavailable',
};

/** Merges OPS, FIELDS and TAGS into the generated document. Throws on any undocumented route. */
export function enrichOpenApi(doc: OpenAPIObject): OpenAPIObject {
  doc.info.description = DESCRIPTION;
  doc.tags = TAGS;
  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas.ApiError = errorSchema;

  const missing: string[] = [];
  const seen = new Set<string>();

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item) as [string, any][]) {
      const key = `${method.toUpperCase()} ${path}`;
      const d = OPS[key];
      seen.add(key);
      if (!d) {
        missing.push(key);
        continue;
      }
      const isAdmin = path.startsWith('/admin');
      op.summary = d.summary;
      if (d.description) op.description = d.description;
      if (!op.tags?.length) op.tags = ['System'];
      if (d.public) op.security = [];
      op.parameters ??= [];

      // path params that Nest omitted (e.g. on @Post(':id/sign') without a pipe)
      for (const m of path.matchAll(/\{(\w+)\}/g)) {
        if (!op.parameters.some((p: any) => p.in === 'path' && p.name === m[1])) {
          op.parameters.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
        }
      }
      for (const p of op.parameters) {
        if (p.in === 'path' && !p.description) p.description = m1(p.name);
      }
      if (d.paged) {
        for (const [name, desc, def, max] of [['page', 'Page number, starting at 0', 0, undefined], ['size', 'Items per page (1–50)', 20, 50]] as const) {
          if (!op.parameters.some((p: any) => p.in === 'query' && p.name === name)) {
            op.parameters.push({ name, in: 'query', required: false, description: desc, schema: { type: 'integer', minimum: name === 'size' ? 1 : 0, ...(max ? { maximum: max } : {}), default: def } });
          }
        }
      }
      for (const [name, q] of Object.entries(d.query ?? {})) {
        if (!op.parameters.some((p: any) => p.in === 'query' && p.name === name)) op.parameters.push({ name, in: 'query', required: false, ...q });
      }
      for (const p of op.parameters) if (p.in === 'query' && !p.description) p.description = QUERY_DESC[p.name] ?? p.name;

      if (d.multipart) {
        const props: Record<string, any> = { file: { type: 'string', format: 'binary', description: d.multipart.file } };
        const required = ['file'];
        for (const [name, f] of Object.entries(d.multipart.fields ?? {})) {
          props[name] = { type: 'string', description: f.description, example: f.example };
          if (f.required) required.push(name);
        }
        op.requestBody = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required, properties: props } } } };
      } else if (d.body !== undefined && op.requestBody?.content?.['application/json']) {
        op.requestBody.content['application/json'].example = d.body;
      } else if (d.body !== undefined) {
        op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object' }, example: d.body } } };
      }

      const status = d.status ?? (method === 'post' ? 201 : 200);
      const responses: Record<string, any> = {
        [status]: { description: d.ok.description, ...(d.ok.example !== undefined ? { content: { 'application/json': { example: d.ok.example } } } : {}) },
      };
      const errs: ErrorCase[] = [...(d.errors ?? [])];
      if (op.requestBody && !d.multipart && !errs.some((e) => e[1] === 'VALIDATION_FAILED')) errs.push([400, 'VALIDATION_FAILED', 'A field is missing or invalid; message lists the fields']);
      if (!d.public && !errs.some((e) => e[0] === 401)) errs.push([401, 'UNAUTHORIZED', 'Unauthorized']);
      if (isAdmin) errs.push([403, 'FORBIDDEN', 'Not allowed (ADMIN role required)']);
      if (!d.public) errs.push([429, 'RATE_LIMITED', 'ThrottlerException: Too Many Requests']);
      const byStatus = new Map<number, ErrorCase[]>();
      for (const e of errs) byStatus.set(e[0], [...(byStatus.get(e[0]) ?? []), e]);
      for (const [code, cases] of [...byStatus].sort((a, b) => a[0] - b[0])) {
        responses[code] = {
          description: `${STATUS_TEXT[code] ?? 'Error'}: ${cases.map((c) => c[1]).join(', ')}`,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ApiError' },
              examples: Object.fromEntries(cases.map((c) => [c[1], { value: { code: c[1], message: c[2], requestId: '3f0c9b2e-1a4d-4c8b-9e7f-2d1a6b5c4e30' } }])),
            },
          },
        };
      }
      op.responses = responses;
    }
  }

  // request field descriptions + examples
  for (const [schema, fields] of Object.entries(FIELDS)) {
    const s: any = doc.components.schemas[schema];
    if (!s?.properties) continue;
    for (const [prop, f] of Object.entries(fields)) {
      if (!s.properties[prop]) continue;
      s.properties[prop].description = f.description;
      if (f.example !== undefined) s.properties[prop].example = f.example;
    }
  }

  // The swagger plugin copies JS regex literals ("/^\\d{6}$/"); OpenAPI wants the bare pattern.
  for (const s of Object.values(doc.components.schemas) as any[]) {
    for (const p of Object.values(s.properties ?? {}) as any[]) {
      if (typeof p.pattern === 'string' && /^\/.*\/[a-z]*$/.test(p.pattern)) p.pattern = p.pattern.replace(/^\/(.*)\/[a-z]*$/, '$1');
    }
  }
  delete doc.components.schemas.DocumentUploadDto; // documented as multipart form fields instead
  doc.info.license = { name: 'Proprietary' };
  // Same-origin first, so "Try it out" hits whichever server is showing the docs.
  doc.servers = [
    { url: '/', description: 'This server' },
    { url: 'https://main.doi0il8u9q02x.amplifyapp.com', description: 'Staging (AWS Amplify)' },
    { url: 'http://localhost:3000', description: 'Local development' },
  ];

  const stale = Object.keys(OPS).filter((k) => !seen.has(k));
  if (missing.length || stale.length) {
    throw new Error(`OpenAPI docs out of sync. Undocumented: ${missing.join('; ') || 'none'}. Documented but missing route: ${stale.join('; ') || 'none'}`);
  }
  return doc;
}

const QUERY_DESC: Record<string, string> = {
  status: 'Filter by status',
  block: 'Filter by block',
  facing: 'Filter by facing direction',
  kind: 'COMMISSION or MATCHING',
  userId: 'Filter by user ID',
  search: 'Name, mobile, email or referral code',
  role: 'USER or ADMIN',
  partnerStatus: 'NONE, PENDING, APPROVED, REJECTED or SUSPENDED',
  level: 'Team level: 0 = all, or 1, 2, 3',
  entity: 'Entity type, e.g. user, booking, plot',
  entityId: 'Entity ID',
  dead: 'true = only jobs that failed permanently',
};

function m1(name: string) {
  return name === 'key' ? 'Setting key' : name === 'id' ? 'Resource ID' : name;
}
