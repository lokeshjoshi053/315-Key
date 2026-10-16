#!/usr/bin/env bash
# Live HTTP test of the compiled API: real Postgres + S3 mock + mock Razorpay/Cashfree.
# Usage: test/live/run.sh            (long-running server, as on ECS/Docker)
#        MODE=serverless test/live/run.sh   (Vercel handler + simulated Vercel Cron)
set -euo pipefail
cd "$(dirname "$0")/../.."
LOG=$(mktemp)
cleanup() { kill $API_PID $MOCK_PID 2>/dev/null || true; docker rm -f p315-pg p315-minio >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f p315-pg p315-minio >/dev/null 2>&1 || true
docker run -d --name p315-pg -p 55432:5432 -e POSTGRES_DB=plots315 -e POSTGRES_USER=plots315 -e POSTGRES_PASSWORD=plots315 postgres:16-alpine >/dev/null
docker run -d --name p315-minio -p 59000:9090 -e initialBuckets=plots315-docs adobe/s3mock:3.11.0 >/dev/null
npm run build >/dev/null
sleep 8
node test/live/mock.js >/dev/null 2>&1 & MOCK_PID=$!
env PORT=3998 APP_ENV=dev DATABASE_URL=postgres://plots315:plots315@localhost:55432/plots315 \
  JWT_SECRET=live-test-secret-live-test-secret-123 CRYPTO_KEY=$(openssl rand -base64 32) BOOTSTRAP_ADMIN_MOBILE=9000000001 \
  RAZORPAY_BASE_URL=http://localhost:4010/v1 RAZORPAY_KEY_ID=rzp_test_live RAZORPAY_KEY_SECRET=rzp_secret_test RAZORPAY_WEBHOOK_SECRET=rzp_webhook_test \
  CASHFREE_BASE_URL=http://localhost:4010/cf CASHFREE_CLIENT_ID=cf CASHFREE_CLIENT_SECRET=cf_secret_test \
  S3_ENDPOINT=http://localhost:59000 S3_ACCESS_KEY=test S3_SECRET_KEY=test CRON_SECRET=cron_secret_test \
  node $([ "${MODE:-server}" = serverless ] && echo test/live/serverless-server.js || echo dist/main.js) > "$LOG" 2>&1 & API_PID=$!
sleep 6
node test/live/smoke.js "$LOG"
