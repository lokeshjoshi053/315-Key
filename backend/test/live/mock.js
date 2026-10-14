// Mock Razorpay (/v1/*) and Cashfree (/cf/*). Control endpoints under /_mock.
const http = require('http');
const payments = {}; // id -> {id, order_id, amount, status}
const calls = [];
let n = 0;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      calls.push({ method: req.method, url: req.url, body: json });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const u = req.url;
      if (u === '/_mock/payment') return (payments[json.id] = json), send(200, {});
      if (u === '/_mock/calls') return send(200, calls);
      if (u === '/v1/orders' && req.method === 'POST') return send(200, { id: `order_mock_${++n}`, amount: json.amount });
      let m = u.match(/^\/v1\/payments\/([^/]+)\/refund$/);
      if (m) return send(200, { id: `rfnd_mock_${++n}`, payment_id: m[1] });
      m = u.match(/^\/v1\/payments\/([^/]+)$/);
      if (m) return payments[m[1]] ? send(200, payments[m[1]]) : send(404, { error: { description: 'not found' } });
      if (u === '/cf/beneficiary') return send(200, { beneficiary_id: json.beneficiary_id });
      if (u === '/cf/transfers') return send(200, { cf_transfer_id: `cf_${++n}`, transfer_id: json.transfer_id });
      send(404, { error: 'unknown ' + u });
    });
  })
  .listen(4010, () => console.log('mock on 4010'));
