const { createApp } = require('./dist/main');

async function start() {
  const port = Number(process.env.PORT || 3000);

  try {
    const app = await createApp();
    await app.listen(port, '0.0.0.0');
    console.log(`315 PLOTS API listening on port ${port}`);
  } catch (error) {
    console.error('Failed to start 315 PLOTS API:', error);
    process.exit(1);
  }
}

start();
