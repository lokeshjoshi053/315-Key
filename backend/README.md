# 315 PLOTS — Backend API

NestJS + PostgreSQL modular monolith for the 315 PLOTS Android/iOS app.
Two roles: **USER** (buys plots; once approved as partner, also refers and earns) and **ADMIN**.
Design and reasoning are in [`../docs/`](../docs/ARCHITECTURE_DECISION.md).

## Run locally

```bash
cp .env.example .env            # set JWT_SECRET, CRYPTO_KEY (openssl rand -base64 32), BOOTSTRAP_ADMIN_MOBILE
docker compose up --build       # Postgres + S3 mock + API on :3000
```
Or, without Docker for the API: `npm ci && npm run start:dev` (needs `DATABASE_URL`).

- Swagger UI: http://localhost:3000/docs (spec: `/docs-json`, committed copy: `openapi.json`, regenerate with `npm run openapi`)
- Full API guide: [`../docs/API_REFERENCE.pdf`](../docs/API_REFERENCE.pdf) / [`.html`](../docs/API_REFERENCE.html), generated from the same spec: `npm run openapi && npx @redocly/cli build-docs openapi.json -o ../docs/API_REFERENCE.html`
- Endpoint docs live in `src/openapi-docs.ts`; a test fails if any route is undocumented
- Health: http://localhost:3000/health
- Migrations run automatically on boot (`MIGRATE_ON_START=false` to disable; `npm run migrate` to run alone).
- In dev, `OTP_PROVIDER=log` prints the OTP in the API logs. This setting is refused when `APP_ENV=prod`.

## Tests

```bash
npm test                        # pure money math (commission, deductions, 70:30 matching)
npm run test:e2e                # real Postgres via Testcontainers: booking race, webhook idempotency,
                                # commission amounts, reversal, authz, OTP + refresh-token reuse
npm run test:live               # 64 checks over HTTP against the built API (long-running server mode)
npm run test:live:serverless    # same 64 checks through the Vercel entry (api/index.js) + simulated Vercel Cron
                                # and mock Razorpay/Cashfree: every endpoint and money flow
```
Colima users should prefix the e2e command with `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true`.

## App integration (Kotlin client)

| Flow | Calls |
| --- | --- |
| Splash | `GET /me/bootstrap` (401 → login) |
| Login | `POST /auth/otp/request` → `POST /auth/otp/verify {mobile, code, referralCode?}` or `POST /auth/google {idToken}` → store `accessToken` + `refreshToken`. On 401, call `POST /auth/refresh` **once, serialized** (a reused refresh token logs out every device) |
| Push | `POST /me/devices {token, platform}` after login |
| Book | `GET /plots` → `GET /tiers` → `POST /bookings {plotId, tierId, termsAccepted:true}` → open Razorpay checkout with `razorpayOrderId` + `razorpayKeyId` → on success `POST /payments/verify {razorpayOrderId, razorpayPaymentId, razorpaySignature}` → poll `GET /bookings/{id}` until `CONFIRMED` |
| Earn | `POST /partners/apply` → admin approves → `GET /partners/me` (code/link), `/partners/network`, `/leads`, `/commissions`, `/matching/summary`, `PUT /payouts/beneficiary`, `GET /payouts` |

- All money values are **integer paise** (`amountPaise`). Display ₹ = paise / 100.
- Errors always look like `{ "code": "PLOT_UNAVAILABLE", "message": "…", "requestId": "…" }`. Branch on `code`, not on message.
- Lists take `?page=0&size=20` (max 50) and return `{ items, page, size, total }`.
- Notification `deepLink` values: `booking/{id}`, `payment/{id}`, `document/{id}`, `commission`, `matching`, `payout/{id}`, `partner`.

## Production checklist

- [ ] `APP_ENV=prod`, `SWAGGER_ENABLED=false`, strong `JWT_SECRET` and `CRYPTO_KEY` from a secret manager (rotating `CRYPTO_KEY` needs a re-encrypt migration)
- [ ] Managed Postgres with PITR. Run 1–2 API replicas; scheduled jobs are safe across replicas (advisory locks / `SKIP LOCKED`)
- [ ] Razorpay: live keys, webhook URL `https://<host>/webhooks/razorpay` with events `payment.captured`, `payment.failed`, `refund.processed`, auto-capture ON
- [ ] Cashfree Payouts: webhook `https://<host>/webhooks/cashfree`. **VERIFY** the API version, fields and signature scheme in `src/payout/payouts.ts`
- [ ] MSG91 DLT template approved; `OTP_PROVIDER=msg91`
- [ ] Private S3 bucket; FCM service-account file mounted
- [ ] Legal opinion on the referral/matching plan and TDS filing (see ARCHITECTURE_DECISION risks)
- [ ] Alerts on: `job.dead = true`, webhook signature rejections (log `webhook`), `AMOUNT_MISMATCH`

## Known gaps (deliberate)

- **eSign:** no provider chosen. `POST /documents/:id/sign` returns 501, and admin sets document status manually.
- **Receipts:** returned as JSON (`GET /payments/:id/receipt`) for the app to render. Add server-side PDF only if needed.
- **Matching rule:** `src/ledger/math.ts › matchVolume` is a placeholder for business question A-4. Only that function changes when the rule is confirmed.
- **Clawback of a matching bonus** when a booking is refunded is not automatic. Volume is removed, and admin can hold entries.
