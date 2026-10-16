// Vercel function: every request is rewritten here (see vercel.json) and handled by the NestJS app.
module.exports = require('../backend/dist/serverless').default;
