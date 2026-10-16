// Serverless entry (Vercel). The default export is a plain (req, res) handler.
// Static imports so Vercel's file tracer bundles what Nest would otherwise load dynamically.
import '@nestjs/platform-express';
import 'class-validator';
import 'class-transformer';
import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from './main';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Timers don't survive between invocations; Vercel Cron drives background work via /internal/cron/*.
process.env.SCHEDULERS ??= 'off';

let ready: Promise<Handler> | undefined;

async function init(): Promise<Handler> {
  const app = await createApp();
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // One Nest app per warm instance; a failed cold start is retried on the next request.
  ready ??= init().catch((e) => {
    ready = undefined;
    throw e;
  });
  (await ready)(req, res);
}
