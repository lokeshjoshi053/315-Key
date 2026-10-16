# Deploying to Vercel

The repo root has `vercel.json` and `api/index.js`. Vercel builds the backend with `nest build` and serves every request through one serverless function. Background work runs through Vercel Cron instead of timers.

## Project settings

| Setting | Value |
| --- | --- |
| Root Directory | repository root (leave blank), **not** `backend` |
| Framework Preset | Other (`vercel.json` sets `"framework": null`) |
| Build / Install / Output | leave empty; `vercel.json` sets them |

## Environment variables (Settings → Environment Variables, Production)

| Name | Value |
| --- | --- |
| `APP_ENV` | `prod` |
| `DATABASE_URL` | your RDS URL (use a dedicated app user, not `postgres`) |
| `DB_SSL` | `verify` |
| `DB_POOL_SIZE` | `3` (each warm function instance opens its own pool) |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `CRYPTO_KEY` | `openssl rand -base64 32` (back it up) |
| `CRON_SECRET` | `openssl rand -hex 32`; Vercel sends it to the cron endpoints automatically |
| `BOOTSTRAP_ADMIN_MOBILE` | your mobile |
| `OTP_PROVIDER`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | `msg91` + keys |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from Razorpay |
| `FCM_CREDENTIALS_JSON` | the Firebase key JSON (paste the whole file) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | an IAM user limited to the documents bucket |
| `SWAGGER_ENABLED` | `false` |
| `CASHFREE_*`, `GOOGLE_CLIENT_IDS` | when you enable payouts / Google login |

Don't set `SCHEDULERS`; the serverless entry sets it to `off` by itself.

## Things specific to Vercel

- **Cron needs the Pro plan.** `/internal/cron/minute` runs every minute: it sends queued push notifications and Razorpay refunds, frees lapsed holds and promotes eligible commission. On Hobby, Vercel only allows daily crons, so pushes and refunds would wait up to a day. Booking itself stays correct either way, because lapsed holds are also released whenever someone books.
- **Database access.** Vercel functions don't have fixed IP addresses, so RDS must accept connections from the internet: keep `DB_SSL=verify`, use a long random password for a non-superuser, and consider **RDS Proxy** to cap connections when traffic grows.
- **Cold starts.** The first request on a new instance boots NestJS and checks migrations (about 1–3 s). Later requests on that instance are fast.
- **Webhooks:** Razorpay → `https://<your-domain>/webhooks/razorpay`, Cashfree → `https://<your-domain>/webhooks/cashfree`.
- **AWS Amplify:** if an `amplify.yml` is still connected to the repo, disconnect that Amplify app. It can't run this API.

## Verify after deploying

1. `https://<your-domain>/health` returns `{"status":"ok"}`.
2. Vercel → Project → Settings → Cron Jobs lists both jobs; trigger `minute` once by hand and check its log returns `{"ok":true,...}`.
3. Sign in with OTP using `BOOTSTRAP_ADMIN_MOBILE` (the code is in the function logs only if `OTP_PROVIDER=log`, which is refused in prod, so use MSG91).

To test the same code path locally: `npm run test:live:serverless` (runs `api/index.js` with a simulated Vercel Cron against Postgres and mock providers).
