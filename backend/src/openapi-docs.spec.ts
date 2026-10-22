import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

// Builds the real Swagger document from the app's routes (no database connection is made).
describe('OpenAPI documentation', () => {
  let app: INestApplication;
  let doc: any;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://unused@localhost:1/unused',
      JWT_SECRET: 'x'.repeat(40),
      CRYPTO_KEY: Buffer.alloc(32, 1).toString('base64'),
      JOBS_ENABLED: 'false',
    });
    const { AppModule } = await import('./app.module');
    const { swaggerConfig } = await import('./main');
    const { enrichOpenApi } = await import('./openapi-docs');
    app = await NestFactory.create(AppModule, { logger: false });
    doc = enrichOpenApi(SwaggerModule.createDocument(app, swaggerConfig())); // throws if any route is undocumented
  });

  afterAll(() => app?.close());

  const ops = () => Object.entries(doc.paths).flatMap(([path, item]: [string, any]) => Object.entries(item).map(([method, op]: [string, any]) => ({ key: `${method.toUpperCase()} ${path}`, op })));

  it('documents every endpoint with a summary, a success response and error responses', () => {
    const bad = ops().filter(({ op }) => {
      const codes = Object.keys(op.responses).map(Number);
      return !op.summary || !codes.some((c) => c >= 200 && c < 300) || !codes.some((c) => c >= 400) || !op.tags?.length;
    });
    expect(bad.map((b) => b.key)).toEqual([]);
    expect(ops().length).toBeGreaterThanOrEqual(74);
  });

  it('marks protected endpoints with bearer auth and 401, public ones with no security', () => {
    for (const { key, op } of ops()) {
      const isPublic = Array.isArray(op.security) && op.security.length === 0;
      if (!isPublic) {
        expect([key, op.security]).toEqual([key, [{ bearer: [] }]]);
        expect([key, !!op.responses['401']]).toEqual([key, true]);
      }
    }
    const publicOps = ops().filter(({ op }) => op.security?.length === 0).map((o) => o.key);
    expect(publicOps).toEqual(expect.arrayContaining(['POST /auth/otp/request', 'POST /webhooks/razorpay', 'GET /health']));
  });

  it('gives every admin endpoint a 403 and every paged list page/size', () => {
    for (const { key, op } of ops().filter((o) => o.key.includes(' /admin/'))) expect([key, !!op.responses['403']]).toEqual([key, true]);
    for (const path of ['/bookings', '/payments', '/leads', '/notifications', '/admin/users']) {
      expect(doc.paths[path].get.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(['page', 'size']));
    }
  });

  it('describes file uploads as multipart', () => {
    expect(Object.keys(doc.paths['/admin/documents'].post.requestBody.content)).toEqual(['multipart/form-data']);
    expect(Object.keys(doc.paths['/admin/plots/import'].post.requestBody.content)).toEqual(['multipart/form-data']);
  });
});
