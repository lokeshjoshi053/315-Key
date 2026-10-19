#!/usr/bin/env bash
# Builds the API into AWS Amplify Hosting's Web Compute layout (.amplify-hosting/ at the repo root):
#   .amplify-hosting/deploy-manifest.json        routes every path to the compute function
#   .amplify-hosting/compute/default/server.js   starts NestJS on port 3000
#   .amplify-hosting/compute/default/{dist,migrations,certs,node_modules,.env}
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/.amplify-hosting"
FN="$OUT/compute/default"

# Fail the build (not the live app) when required settings are missing or malformed.
node -e '
const e = process.env, bad = [];
const ck = (e.CRYPTO_KEY || "").trim();
if (Buffer.from(ck, "base64").length !== 32)
  bad.push(`CRYPTO_KEY: must be 44 characters from "openssl rand -base64 32" (got ${ck.length} characters)`);
if ((e.JWT_SECRET || "").length < 32) bad.push(`JWT_SECRET: must be at least 32 characters (got ${(e.JWT_SECRET || "").length})`);
if (!e.DATABASE_URL) bad.push("DATABASE_URL: not set");
else if (/\s/.test(e.DATABASE_URL.trim())) bad.push("DATABASE_URL: contains a space (e.g. before :5432); remove it");
if (e.APP_ENV === "prod" && (e.OTP_PROVIDER || "log") === "log") bad.push("OTP_PROVIDER: must be msg91 when APP_ENV=prod");
if (bad.length) {
  console.error("Amplify environment variables are not set correctly (Hosting > Environment variables):\n  - " + bad.join("\n  - "));
  process.exit(1);
}
console.log("environment variables OK");
'

cd "$ROOT/backend"
npm ci
npm run build

rm -rf "$OUT"
mkdir -p "$FN" "$OUT/static"
cp -R dist migrations certs package.json package-lock.json "$FN/"
cp deploy/amplify/server.js "$FN/server.js"
cp deploy/amplify/deploy-manifest.json "$OUT/deploy-manifest.json"
(cd "$FN" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# Amplify passes environment variables to the build only. Copy the app's variables into .env,
# single-quoted so values (e.g. the Firebase key JSON with \n in it) stay byte-for-byte.
node -e '
const keys = process.argv.slice(1);
const lines = [];
for (const k of keys) {
  const v = process.env[k];
  if (v === undefined || v === "") continue;
  if (v.includes("\x27") || v.includes("\n")) { console.error(`skipping ${k}: value must be one line without single quotes`); continue; }
  lines.push(`${k}=\x27${v}\x27`);
}
require("fs").writeFileSync("'"$FN"'/.env", lines.join("\n") + "\n", { mode: 0o600 });
console.log(`wrote ${lines.length} variables to .env`);
' APP_ENV DATABASE_URL DB_POOL_SIZE DB_SSL DB_SSL_CA MIGRATE_ON_START JWT_SECRET CRYPTO_KEY \
  BOOTSTRAP_ADMIN_MOBILE REFERRAL_LINK_BASE CORS_ORIGINS SWAGGER_ENABLED \
  OTP_PROVIDER MSG91_AUTH_KEY MSG91_TEMPLATE_ID GOOGLE_CLIENT_IDS \
  RAZORPAY_BASE_URL RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET \
  CASHFREE_BASE_URL CASHFREE_CLIENT_ID CASHFREE_CLIENT_SECRET \
  S3_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY S3_SECRET_KEY \
  FCM_CREDENTIALS_JSON CRON_SECRET SCHEDULERS JOBS_ENABLED

echo "Amplify Web Compute bundle: $(du -sh "$FN" | cut -f1)"
