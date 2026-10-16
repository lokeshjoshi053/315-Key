import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { Db, migrate } from './db';
import { AllExceptionsFilter, requestId } from './common/http';

export function swaggerConfig() {
  return new DocumentBuilder()
    .setTitle('315 PLOTS API')
    .setDescription(
      'Backend for the 315 PLOTS mobile app. Roles: USER (customer; partner once approved) and ADMIN.\n\n' +
        'Auth: call POST /auth/otp/request then /auth/otp/verify, click Authorize and paste the accessToken.\n\n' +
        'Money is integer paise (amountPaise 2100000 = Rs 21,000). Lists take page/size (max 50). ' +
        'Errors: { code, message, requestId }. Full guide: docs/API_REFERENCE.pdf.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
}

export async function configureApp(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  app.use(requestId);
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  return app;
}

/** Fully configured app, not yet listening. Shared by the server (bootstrap) and serverless entry. */
export async function createApp() {
  const cfg = loadConfig();
  // rawBody: webhook signatures are computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await configureApp(app);
  app.enableCors({ origin: cfg.corsOrigins.length ? cfg.corsOrigins : false });
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);

  if (process.env.MIGRATE_ON_START !== 'false') await migrate(app.get(Db).pool);

  if (cfg.swagger) {
    const doc = SwaggerModule.createDocument(app, swaggerConfig());
    SwaggerModule.setup('docs', app, doc, { swaggerOptions: { persistAuthorization: true } });
  }
  return app;
}

async function bootstrap() {
  const cfg = loadConfig();
  const app = await createApp();
  await app.listen(cfg.port);
  new Logger('main').log(`315 PLOTS API on :${cfg.port} (${cfg.env})`);
}

if (require.main === module) bootstrap();
