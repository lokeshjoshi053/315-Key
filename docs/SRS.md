# SRS — 315 PLOTS Backend

## 1. Purpose & scope
A backend for the 315 PLOTS Kotlin mobile app. It handles plot sales (315 plots at
₹50 L each) through 5 booking tiers, a 3-level referral commission, 70:30 matching,
and payouts.

**In scope (V1):** OTP + Google auth, profiles, plot inventory and holds, booking,
Razorpay payment, documents and eSign, notifications (FCM), referral tree, commission
ledger, matching ledger, Cashfree payouts, admin APIs, audit log.
**Out of scope:** KYC (removed per PDF), web admin UI (the admin uses the app),
EMI/loan, multi-project.

## 2. Actors
| Actor | Capabilities |
| --- | --- |
| **USER** | Logs in. Books and pays for plots and views their documents. Once `partnerStatus=APPROVED`, also shares a referral code, registers leads, and sees their network, commission, matching and payouts |
| **ADMIN** | Manages plots, tiers and pricing. Approves, rejects or suspends partners and users. Views all bookings and payments. Approves, holds or reverses commission. Triggers payouts. Uploads documents and sends notifications. Reads the audit log |
| Razorpay / Cashfree / eSign | Systems that call webhooks |

Partner capability is a **status on USER**, not a role (C6).

## 3. Functional requirements

### FR-1 Auth
- 1.1 Request an OTP for a mobile number: a 6-digit code with a 5-minute expiry, max 3 sends per 15 min and max 5 verify attempts.
- 1.2 Verify the OTP, or accept a Google ID token (verified server-side), and return an access JWT (15 min) plus a refresh token (30 days, rotating, stored hashed).
- 1.3 `GET /me/bootstrap` returns profile completeness, `partnerStatus`, role and min app version (splash routing for C01/A01).
- 1.4 Logout revokes the refresh token for that device. Admin can revoke all of a user's sessions.
- 1.5 Admin accounts are seeded or created by an admin only. The app cannot self-register an admin.

### FR-2 Users & partners
- 2.1 Profile: name, email, mobile, address, nominee (name and relation). Server validates required fields.
- 2.2 On signup, an optional `referralCode` sets `sponsorId`. **The sponsor is immutable after the first booking.**
- 2.3 The user applies as a partner (`NONE→PENDING`). Admin approves or rejects (`APPROVED/REJECTED`) or suspends.
- 2.4 Approved partners get a unique referral code and a deep link.
- 2.5 Leads: a partner registers name and mobile. When that mobile signs up, it links to the partner as sponsor (if none was set).

### FR-3 Plots & tiers
- 3.1 List plots with filters (status, facing, size, block) and pagination, plus lat/lng for the map.
- 3.2 Plot statuses: `AVAILABLE, HELD, BOOKED, BLOCKED`. Only `AVAILABLE` is bookable.
- 3.3 Tiers are admin-configurable. Seed values: Express ₹21,000; Advance ₹71,000; Silver ₹1,51,000; Gold ₹3,00,000; Platinum ₹6,51,000, with L1/L2/L3 % per PDF §6.
- 3.4 Admin CRUD on plots and tiers. Price changes never alter existing bookings (the booking snapshots the amount and percentages).

### FR-4 Booking & payment
- 4.1 `POST /bookings {plotId, tierId, termsAccepted}` locks the plot row, sets `AVAILABLE→HELD` (hold 15 min), creates the booking `PENDING_PAYMENT`, and creates a Razorpay order. **Two concurrent requests for one plot: exactly one succeeds, the other gets 409 `PLOT_UNAVAILABLE`.**
- 4.2 The client's success callback only triggers a status poll. **Payment becomes `VERIFIED` only from a signature-verified webhook, or a server-side fetch of the order.**
- 4.3 Webhook processing is idempotent on the provider event ID and payment ID. **A duplicate webhook creates no new rows.**
- 4.4 On verified capture, in one transaction: payment `VERIFIED`, booking `CONFIRMED`, plot `BOOKED`, commission rows, matching volume, jobs (notify, agreement, receipt).
- 4.5 Hold expiry job: `HELD` past expiry with no verified payment sets the plot back to `AVAILABLE` and the booking to `EXPIRED`. Failed payment can be retried while the hold is live.
- 4.6 Capture arrives after the hold expired and the plot was re-held by someone else: payment is `VERIFIED`, the booking goes to `REFUND_PENDING`, an admin is alerted, and a refund is issued via the provider.
- 4.7 Every booking and payment exposes `internalRef` (e.g. `BK-2026-000123`) and `providerRef`.
- 4.8 Payment history and receipts (PDF generated on verify).

### FR-5 Documents
- 5.1 Types: `AGREEMENT, RECEIPT, ALLOTMENT, OTHER`. Statuses: `PENDING→SENT→SIGNED | REJECTED | EXPIRED`.
- 5.2 Files live in a private bucket. Download is via a pre-signed URL with a TTL of 5 minutes.
- 5.3 eSign: send to provider, then a provider webhook updates the status.

### FR-6 Commission (3-level)
- 6.1 On a verified booking, walk the sponsor chain up 3 levels. For each **approved** partner ancestor, write `gross = amount × levelPct`. Skip levels with no ancestor or a non-approved one (no compression, see A-3).
- 6.2 Deductions: `admin = gross × 20%`, `tds = gross × 5%`, `net = gross − admin − tds` (A-2). Stored as integer paise.
- 6.3 Statuses: `PENDING → ELIGIBLE → APPROVED → PAID`, plus `ON_HOLD` and `REVERSED`. Eligibility is time-based (cooling period, default 7 days, configurable). Admin approves.
- 6.4 Refund or cancellation of a booking writes `REVERSED` entries for all derived commission and matching.
- 6.5 **Commission per (booking, beneficiary, level) is unique.**

**Levels.** Level 1 (L1) is the buyer's direct sponsor (the partner whose referral code or lead brought them in). Level 2 (L2) is L1's sponsor. Level 3 (L3) is L2's sponsor. Nothing is paid above Level 3.

**Commission percentage per level, by booking plan** (from the business plan; stored per plan in `tier.l1_bps / l2_bps / l3_bps`, 100 bps = 1%, and snapshotted on each booking):

| Plan | Booking amount | Level 1 | Level 2 | Level 3 | Total gross |
| --- | --- | --- | --- | --- | --- |
| Express Token | ₹21,000 | 10% (₹2,100) | 5% (₹1,050) | 5% (₹1,050) | 20% (₹4,200) |
| Advance Token | ₹71,000 | 15% (₹10,650) | 5% (₹3,550) | 5% (₹3,550) | 25% (₹17,750) |
| Silver | ₹1,51,000 | 15% (₹22,650) | 10% (₹15,100) | 10% (₹15,100) | 35% (₹52,850) |
| Gold | ₹3,00,000 | 20% (₹60,000) | 10% (₹30,000) | 10% (₹30,000) | 40% (₹1,20,000) |
| Platinum | ₹6,51,000 | 25% (₹1,62,750) | 15% (₹97,650) | 10% (₹65,100) | 50% (₹3,25,500) |

**Worked example (Gold, ₹3,00,000)**, deductions per 6.2 (20% admin + 5% TDS on gross):

| Level | Partner | Gross | Admin 20% | TDS 5% | Net paid |
| --- | --- | --- | --- | --- | --- |
| Level 1 | Direct sponsor | ₹60,000 | ₹12,000 | ₹3,000 | ₹45,000 |
| Level 2 | Sponsor's sponsor | ₹30,000 | ₹6,000 | ₹1,500 | ₹22,500 |
| Level 3 | Next one up | ₹30,000 | ₹6,000 | ₹1,500 | ₹22,500 |

If Level 2 is not an approved partner at that moment, Level 2 gets nothing and Level 3 still gets its own 10% (no compression, A-3). Verified by the unit and live tests (`src/ledger/math.spec.ts`, live suite "commission: C L1 ₹60,000 …").

### FR-7 Matching (70:30)
- 7.1 Each partner has left and right volume (see A-4 for leg assignment).
- 7.2 A verified booking adds `amount` to the relevant leg of every upline.
- 7.3 Matching runs daily: matched volume follows the rule in A-4, bonus = 50% of matched, the same deductions apply, and the matching ledger row is written. Carry-forward of unmatched volume is configurable.

### FR-8 Payouts
- 8.1 The user adds a bank beneficiary (account no. encrypted, IFSC, PAN). It is validated via the Cashfree beneficiary API (VERIFY).
- 8.2 Admin creates a payout batch from `APPROVED` net entries. Statuses: `REQUESTED→PROCESSING→PAID | FAILED`. A webhook updates the status. `FAILED` returns entries to `APPROVED`.
- 8.3 **One ledger entry can be in at most one non-failed payout.**

### FR-9 Notifications
- 9.1 Store in an inbox with category, deep link (`booking/{id}`, `payment/{id}`, `document/{id}`, `commission/{id}`, `payout/{id}`) and read flag, then push via FCM.
- 9.2 Device token registration per session. Admin broadcast to all users or partners.

### FR-10 Admin & audit
- 10.1 Admin dashboard: plots by status, bookings and revenue by tier, pending partner approvals, commission due, payout status.
- 10.2 **Every admin mutation writes `audit_log(actor, action, entity, before, after, at)`.**
- 10.3 Nightly reconciliation compares Razorpay and Cashfree settlements with local records and flags mismatches.

## 4. Non-functional requirements
| ID | Requirement | Target |
| --- | --- | --- |
| NFR-1 | API latency (reads) | p95 < 200 ms, p99 < 500 ms at 50 rps |
| NFR-2 | Webhook processing | p95 < 1 s. Always return 2xx after durable insert |
| NFR-3 | Booking notification after webhook | < 10 s p95 |
| NFR-4 | Availability | 99.5% monthly |
| NFR-5 | Data durability | Daily snapshots + PITR 7 days. RPO ≤ 5 min, RTO ≤ 1 h |
| NFR-6 | Money | Integer paise only. **0** double-bookings, **0** duplicate ledger rows (DB constraints) |
| NFR-7 | Security | TLS 1.2+. Bank account and PAN encrypted (AES-GCM, key in secret manager). JWT RS256. Rate limit 60 req/min/user, 5 OTP req/15 min/number |
| NFR-8 | Pagination | All lists cursor- or page-based, max 50 per page |
| NFR-9 | Observability | Structured JSON logs with `requestId`, `/actuator/health`, alerts on webhook signature failure and job lag > 60 s |
| NFR-10 | Tests | Booking race, webhook idempotency, commission math and reversal covered by automated tests in CI |

## 5. Canonical domain model

```kotlin
enum class Role { USER, ADMIN }
enum class PartnerStatus { NONE, PENDING, APPROVED, REJECTED, SUSPENDED }
enum class PlotStatus { AVAILABLE, HELD, BOOKED, BLOCKED }
enum class BookingStatus { PENDING_PAYMENT, CONFIRMED, EXPIRED, CANCELLED, REFUND_PENDING, REFUNDED }
enum class PaymentStatus { CREATED, PENDING, VERIFIED, FAILED, REFUNDED }
enum class LedgerKind { COMMISSION, MATCHING }
enum class LedgerStatus { PENDING, ELIGIBLE, APPROVED, PAID, ON_HOLD, REVERSED }
enum class PayoutStatus { REQUESTED, PROCESSING, PAID, FAILED }
enum class DocStatus { PENDING, SENT, SIGNED, REJECTED, EXPIRED }

// Money is always Long paise. ₹21,000 = 2_100_000
data class LedgerEntry(
    val id: UUID,
    val userId: UUID,           // beneficiary
    val kind: LedgerKind,
    val level: Int?,            // 1..3 for COMMISSION
    val sourceBookingId: UUID?, // COMMISSION link to origin
    val sourceMatchRunId: UUID?,// MATCHING link to origin
    val grossPaise: Long,
    val adminPaise: Long,
    val tdsPaise: Long,
    val netPaise: Long,
    val reversesId: UUID?,      // set on REVERSED entries
    val createdAt: Instant,
)
```

## 6. Core entities (tables)
`app_user` (role, partner_status, sponsor_id, referral_code, left_parent?, leg?) ·
`refresh_token` · `otp_challenge` · `device_token` · `nominee` · `lead` ·
`project` · `plot` · `tier` · `booking` · `payment` · `webhook_event` ·
`document` · `notification` · `ledger_entry` · `ledger_entry_status` (append-only history) ·
`match_volume` · `match_run` · `beneficiary` · `payout` · `payout_item` ·
`job` (outbox) · `audit_log` · `app_config`

## 7. Acceptance criteria — V1 "done"
1. **Race test:** 50 concurrent `POST /bookings` for one plot yield exactly 1 × 201 and 49 × 409.
2. **Idempotency test:** replaying the same Razorpay webhook 10× yields 1 payment `VERIFIED`, 1 booking, and 3 commission rows max.
3. **Crash test:** killing the app mid-webhook, then the provider retrying, leaves no partial state (single transaction).
4. **Commission math:** a Gold booking with a 3-deep upline gives L1 ₹60,000 gross / ₹45,000 net, L2 ₹30,000 / ₹22,500, L3 ₹30,000 / ₹22,500.
5. **Reversal:** refunding a booking nets every derived ledger sum for that booking to 0.
6. Client-reported success never confirms a booking without a webhook or server fetch.
7. Hold expiry frees the plot within 1 min of TTL.
8. A USER calling `/admin/**` gets 403. User A cannot read user B's booking, document or ledger (403/404).
9. Every admin mutation appears in `audit_log`.

## 8. Assumptions (confirm with business)
- **A-1** USER = buyer + partner in one account. Partner features gate on `partnerStatus=APPROVED`.
- **A-2** Admin 20% and TDS 5% are both applied to gross, so net = 75% of gross.
- **A-3** Commission levels follow the sponsor chain. A non-approved ancestor's share is **forfeited** (not passed up).
- **A-4** **Matching (open):** this assumes a binary placement where each partner places a recruit on the left or right leg. Matched volume = `min(power×0.7, weak×0.3)`-style rule still to be defined. Implement as a pure function `matchedVolume(left, right, carry): MatchResult` behind config so the rule can change without schema changes.
- **A-5** Commission is computed on the tier payment amount, not the ₹50 L plot price.
- **A-6** Hold TTL is 15 min and the cooling period is 7 days (both in `app_config`).
- **A-7** A single project with 315 plots, seeded by an admin CSV import.
