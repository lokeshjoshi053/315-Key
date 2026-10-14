// Writes openapi.json without a database: npm run openapi
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { join } from 'path';

process.env.DATABASE_URL ??= 'postgres://unused@localhost:1/unused';
process.env.JWT_SECRET ??= 'openapi-export-openapi-export-openapi-export';
process.env.CRYPTO_KEY ??= Buffer.alloc(32).toString('base64');
process.env.JOBS_ENABLED = 'false';

(async () => {
  const { AppModule } = await import('./app.module');
  const { swaggerConfig } = await import('./main');
  const app = await NestFactory.create(AppModule, { logger: false });
  const doc = SwaggerModule.createDocument(app, swaggerConfig());
  writeFileSync(join(__dirname, '..', 'openapi.json'), JSON.stringify(doc, null, 2));
  await app.close().catch(() => undefined);
  console.log(`openapi.json: ${Object.keys(doc.paths).length} paths`);
  process.exit(0);
})();
