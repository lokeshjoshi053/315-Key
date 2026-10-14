# Project Guide — 315 PLOTS Backend

## Tech stack
| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22, TypeScript 5 (strict) | Team choice |
| Framework | NestJS 10 | DI, guards, validation pipes, scheduler, Swagger built in |
| DB access | `pg` + hand-written SQL | Row locks, `SKIP LOCKED`, partial unique indexes and triggers are the correctness net; no ORM hides them |
| DB | PostgreSQL 16 (managed: RDS / Neon / Supabase-PG) | |
| Migrations | Plain `migrations/V*.sql`, applied on boot under an advisory lock | No extra tool |
| Auth | `@nestjs/jwt` HS256 access (15 min) + rotating hashed refresh (30 d); Google ID token via `jose` | |
| Rate limit | `@nestjs/throttler` (120/min global per IP; OTP 30/min per IP + 3 per 15 min per mobile) | NFR-7 |
| Payments | Razorpay Orders + webhooks (VERIFY) | Named in PDF |
| Payouts | Cashfree Payouts v2 (VERIFY) | Named in PDF |
| OTP | MSG91 flow API (VERIFY DLT template) | |
| Push | `firebase-admin` FCM | |
| Files | S3 / R2 / MinIO, 5-min signed URLs | |
| Tests | Jest unit + Testcontainers e2e on real Postgres | Race test needs a real DB |
| Deploy | Docker image → Railway / Render / ECS + managed PG | |

Skipped: Redis, Kafka, ORM, Kubernetes. Add one only when "When to change" in ARCHITECTURE_DECISION fires.

## Repo layout (as built: `backend/`)

```
backend/
├─ migrations/V1__init.sql, V2__seed.sql   # schema, constraints, ledger trigger, 5 tiers, 315 plots
├─ src/
│  ├─ main.ts, app.module.ts, config.ts, db.ts, migrate.ts
│  ├─ common/      auth guard + roles, error filter, request id, crypto, settings, audit, refs
│  ├─ auth/        OTP, Google, tokens                     → /auth/**
│  ├─ users/       profile, nominee, devices, partner, leads, network → /me/**, /partners/**, /leads
│  ├─ plots/       plots, tiers                            → /plots/**, /tiers
│  ├─ booking/     hold, checkout, confirm, cancel, expiry → /bookings/**
│  ├─ payment/     PaymentGateway + Razorpay, webhook, refunds → /payments/**, /webhooks/razorpay
│  ├─ ledger/      math.ts (pure), commission, matching, eligibility → /commissions/**, /matching/**
│  ├─ payout/      PayoutGateway + Cashfree, beneficiary, batches → /payouts/**, /webhooks/cashfree
│  ├─ documents/   S3 storage, signed URLs                → /documents/**
│  ├─ notify/      inbox + FCM push                        → /notifications/**
│  ├─ jobs/        transactional outbox runner
│  └─ admin/       everything under /admin/** (ADMIN role)
└─ test/money.e2e-spec.ts                  # AC-1, 2, 4, 5, 8 + OTP/refresh
```

The key code to read first: `src/ledger/math.ts` (commission/matching), `PaymentService.apply` (webhook idempotency), `BookingService.create/onPaymentVerified` (holds + late-capture refund).

## API surface (V1)

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/google`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me/bootstrap` |
| Profile | `GET/PUT /me`, `PUT /me/nominee`, `POST /me/devices` |
| Partner | `POST /partners/apply`, `GET /partners/me` (code, link), `GET /partners/network?level=`, `POST/GET /leads` |
| Plots | `GET /plots?status=&page=`, `GET /plots/{id}`, `GET /tiers` |
| Booking | `POST /bookings`, `GET /bookings`, `GET /bookings/{id}`, `POST /bookings/{id}/retry-payment` |
| Payment | `GET /payments`, `GET /payments/{id}/receipt`, `POST /webhooks/razorpay` |
| Documents | `GET /documents`, `GET /documents/{id}/url`, `POST /documents/{id}/sign`, `POST /webhooks/esign` |
| Earnings | `GET /commissions/summary`, `GET /commissions?status=`, `GET /commissions/{id}`, `GET /matching/summary`, `GET /matching/runs` |
| Payout | `GET/PUT /payouts/beneficiary`, `GET /payouts`, `POST /webhooks/cashfree` |
| Notify | `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all` |
| Admin | `/admin/dashboard`, `/admin/plots` (CRUD + CSV import), `/admin/tiers`, `/admin/users` (+ `/approve`, `/reject`, `/suspend`), `/admin/bookings`, `/admin/payments`, `/admin/commissions` (+ `/approve`, `/hold`, `/reverse`), `/admin/payouts` (batch create), `/admin/documents` (upload/send), `/admin/notifications/broadcast`, `/admin/audit`, `/admin/config` |

Error envelope: `{ "code": "PLOT_UNAVAILABLE", "message": "...", "requestId": "..." }`.
Status enums are returned as strings that match SRS §5 exactly, so the Kotlin app can share them.

## Phased build order

| Week | Goal | Done when |
| --- | --- | --- |
| Status | Item |
| --- | --- |
| ✅ Built | Auth, profile, partners, plots, booking + holds, Razorpay order/webhook/verify/refund, 3-level commission, matching engine, payouts, documents, notifications, admin, audit, outbox jobs |
| ✅ Tested | Booking race, webhook idempotency, commission math, reversal, authz, OTP + refresh reuse |
| ⏭ Next | Razorpay **test-mode** end-to-end from the Android app; Cashfree sandbox round-trip; eSign provider; legal sign-off; A-4 matching rule confirmation |

**On track at end of week 1:** you can tap "Pay" in the Android app (pointed at this API), complete Razorpay
test checkout, and see the booking flip to CONFIRMED from the webhook, with the
plot shown as BOOKED to a second user.

## Latency & resource budget
One 1 vCPU / 2 GB container plus a 2 vCPU Postgres comfortably serves NFR-1 at 50 rps.
Budget for `POST /bookings`: DB lock + insert ~10 ms, Razorpay create order ~300 ms (VERIFY). Do not hold the plot row lock across the HTTP call: commit the hold first, then call Razorpay.

## Non-negotiables
1. Money is `Long` paise, never `Double`.
2. Never trust the client for payment success, amount, or price. The amount comes from the `tier` row.
3. Every webhook: verify the signature on the raw body, then dedupe-insert, then act, all in one transaction.
4. Ledger is append-only. Corrections are reversal rows.
5. Every `/admin/**` mutation goes through `AuditService`.
6. Ownership check on every user-scoped read (`WHERE user_id = :me`).
7. Secrets (Razorpay keys, JWT private key, AES key) come from env or a secret manager, never git.

## First-week checklist
- [ ] Get a legal opinion on the referral + matching scheme (ARCHITECTURE_DECISION risk #1)
- [ ] Open Razorpay and Cashfree **test** accounts. Confirm the business category is acceptable
- [x] NestJS backend scaffolded in `backend/` (see backend/README.md)
- [ ] Testcontainers Postgres in CI
- [ ] `V1__init.sql`: users, plot, tier, booking, payment, webhook_event, job, audit_log
- [ ] Seed 315 plots + 5 tiers
- [ ] Write `BookingRaceTest` **before** the booking service
- [ ] Expose ngrok/cloudflared for Razorpay test webhooks
- [ ] Share the OpenAPI (`springdoc`) URL with the Android dev to align DTOs
- [ ] Get business sign-off on SRS assumptions A-2 … A-6
