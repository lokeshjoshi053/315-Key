import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CONFIG, Config, loadConfig } from './config';
import { Db } from './db';
import { AuthGuard, Public } from './common/auth';
import { Audit, Crypto, Refs, Settings } from './common/support';
import { AdminController } from './admin/admin';
import { AuthController, AuthService, LogOtpSender, Msg91OtpSender, OtpSender, TokenService } from './auth/auth';
import { BookingController, BookingService } from './booking/booking';
import { DocumentsController, Storage } from './documents/documents';
import { Jobs } from './jobs/jobs';
import { EarningsController, LedgerService } from './ledger/ledger';
import { NotificationsController, NotificationService, Push } from './notify/notifications';
import { PaymentGateway, RazorpayGateway } from './payment/gateway';
import { PaymentController, PaymentService, PaymentWebhookController } from './payment/payments';
import { CashfreeGateway, PayoutController, PayoutGateway, PayoutService, PayoutWebhookController } from './payout/payouts';
import { PlotsController, PlotsService } from './plots/plots';
import { CronController } from './cron';
import { MeController, PartnerController, UsersService } from './users/users';

@Public()
@Controller('health')
class HealthController {
  constructor(private readonly db: Db) {}

  @Get()
  async health() {
    await this.db.pool.query('select 1');
    return { status: 'ok' };
  }
}

/**
 * Modular monolith: one deployable, folders are modules.
 * Rule: only ledger/ writes ledger_* and match_* tables.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    JwtModule.registerAsync({
      useFactory: () => {
        const cfg = loadConfig();
        return { secret: cfg.jwtSecret, signOptions: { algorithm: 'HS256', issuer: 'plots315' } };
      },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    MeController,
    PartnerController,
    PlotsController,
    BookingController,
    PaymentController,
    PaymentWebhookController,
    EarningsController,
    PayoutController,
    PayoutWebhookController,
    DocumentsController,
    NotificationsController,
    AdminController,
    CronController,
  ],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    {
      provide: OtpSender,
      inject: [CONFIG],
      useFactory: (cfg: Config) => (cfg.otpProvider === 'msg91' ? new Msg91OtpSender(cfg.msg91.authKey, cfg.msg91.templateId) : new LogOtpSender()),
    },
    { provide: PaymentGateway, useClass: RazorpayGateway },
    { provide: PayoutGateway, useClass: CashfreeGateway },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    Db,
    Settings,
    Audit,
    Refs,
    Crypto,
    Jobs,
    Push,
    Storage,
    NotificationService,
    UsersService,
    TokenService,
    AuthService,
    PlotsService,
    LedgerService,
    BookingService,
    PaymentService,
    PayoutService,
  ],
})
export class AppModule {}
