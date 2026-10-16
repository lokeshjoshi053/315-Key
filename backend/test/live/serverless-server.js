// Runs the Vercel entry (api/index.js) behind a plain HTTP server and plays Vercel Cron,
// so the live suite exercises the exact serverless code path.
const http = require('http');
const handler = require('../../../api/index.js');
const port = Number(process.env.PORT);

http
  .createServer((req, res) =>
    handler(req, res).catch((e) => {
      console.error('handler failed', e);
      res.statusCode = 500;
      res.end();
    }),
  )
  .listen(port, () => console.log(`serverless handler on :${port}`));

// Vercel Cron calls this every minute; every 2 s here so the suite runs quickly.
setInterval(() => {
  fetch(`http://localhost:${port}/internal/cron/minute`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).catch(() => {});
}, 2000);
