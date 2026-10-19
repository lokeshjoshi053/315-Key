// AWS Amplify Hosting (Web Compute) entrypoint. Amplify runs this file and routes requests to port 3000.
const { join } = require('path');

// Amplify only exposes environment variables at build time; build.sh writes them to .env for runtime.
try {
  process.loadEnvFile(join(__dirname, '.env'));
} catch {
  // no .env: variables come from the real environment (local tests)
}

// Compute instances are frozen between requests, so in-process timers are unreliable.
// Background work runs through /internal/cron/* (EventBridge Scheduler), see deploy/AMPLIFY.md.
process.env.SCHEDULERS ??= 'off';

const { createApp } = require('./dist/main');

createApp()
  .then((app) => app.listen(Number(process.env.PORT) || 3000))
  .then(() => console.log(`315 PLOTS API ready on :${process.env.PORT || 3000}`))
  .catch((e) => {
    console.error('Failed to start', e);
    process.exit(1);
  });
