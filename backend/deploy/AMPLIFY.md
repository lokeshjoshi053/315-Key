# Deploying to AWS Amplify Hosting (Web Compute)

`amplify.yml` at the repo root runs `backend/deploy/amplify/build.sh`, which builds the API into `.amplify-hosting/`. That is Amplify's Web Compute layout: a `deploy-manifest.json` that routes every request to a Node 20 function running `server.js`, which starts NestJS on port 3000.

Before this, Amplify uploaded `backend/dist` as static files, so the API never ran ("No index.html detected in deploy folder").

## One-time settings

1. **Switch the app to Web Compute.** It must not be the static "WEB" platform. With the AWS CLI:
   ```bash
   aws amplify update-app --app-id d2rzzm6ek0y62 --platform WEB_COMPUTE --region ap-south-1
   ```
   Or use the Amplify console → App settings → General (VERIFY the region and app ID match yours; the ID comes from your build log).
2. **Environment variables:** Amplify console → Hosting → Environment variables. `build.sh` copies these into the function, because Amplify only provides variables at build time.

   | Name | Value |
   | --- | --- |
   | `APP_ENV` | `prod` |
   | `DATABASE_URL` | RDS URL with a dedicated app user (not `postgres`) |
   | `DB_SSL` | `verify` |
   | `DB_POOL_SIZE` | `3` |
   | `JWT_SECRET` | `openssl rand -base64 48` |
   | `CRYPTO_KEY` | `openssl rand -base64 32` (back it up) |
   | `CRON_SECRET` | `openssl rand -hex 32` |
   | `BOOTSTRAP_ADMIN_MOBILE` | your mobile |
   | `OTP_PROVIDER`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | `msg91` + keys |
   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from Razorpay |
   | `FCM_CREDENTIALS_JSON` | the Firebase key JSON on **one line** (`node -e 'console.log(JSON.stringify(require("./key.json")))'`) |
   | `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | IAM user limited to the documents bucket |
   | `SWAGGER_ENABLED` | `false` |
   | `CASHFREE_*`, `GOOGLE_CLIENT_IDS` | when you enable payouts / Google login |

   Values must be one line without single quotes; the build log says `skipping NAME` if one isn't.
3. **Redeploy** the `main` branch. The build log should end with `Amplify Web Compute bundle: …M` and no "No index.html" warning. Then `https://main.d2rzzm6ek0y62.amplifyapp.com/health` should return `{"status":"ok"}`.

## Background jobs (required)

Amplify freezes the function between requests, so timers can't run. Create an **EventBridge Scheduler** schedule that calls the cron endpoint every minute:

- Target: an **API destination** for `GET https://<your-amplify-domain>/internal/cron/minute`, with a connection using **API key** auth: header `Authorization`, value `Bearer <CRON_SECRET>`.
- Rate: `rate(1 minute)`.
- A second schedule calls `/internal/cron/daily` with `cron(30 1 * * ? *)` in time zone `Asia/Kolkata`.

Without it, push notifications, refunds, commission eligibility and the 70:30 matching don't run. Booking still works, because lapsed holds are also released when someone books.

## Things to know

- **Database access:** Amplify compute doesn't run inside your VPC and has no fixed IP, so RDS must accept internet connections. Keep `DB_SSL=verify`, use a strong password on a non-superuser, and consider RDS Proxy.
- **Harmless build warnings:** `EBADENGINE` (dev-only test packages want Node ≥ 22.19; the build image has 22.18) and `Failed to set up process.env.secrets` (you have no Amplify SSM secrets, which is fine).
- **Better long-term home:** ECS Fargate (`deploy/README.md`) runs the timers in-process and keeps the database private. Amplify works, with the scheduler and public-database trade-offs above.

To reproduce the Amplify bundle locally: `bash backend/deploy/amplify/build.sh`, then `node .amplify-hosting/compute/default/server.js`.
