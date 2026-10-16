import { Controller, Get, Headers } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/auth';
import { unauthorized } from './common/http';
import { safeEqual } from './common/support';
import { BookingService } from './booking/booking';
import { Jobs } from './jobs/jobs';
import { LedgerService } from './ledger/ledger';

/**
 * Background work for serverless hosts (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * On ECS/Docker the in-process timers do this and these endpoints are simply unused.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('internal/cron')
export class CronController {
  constructor(
    private readonly bookings: BookingService,
    private readonly ledger: LedgerService,
    private readonly jobs: Jobs,
  ) {}

  private check(auth: string | undefined) {
    const secret = process.env.CRON_SECRET;
    if (!secret || !auth || !safeEqual(auth, `Bearer ${secret}`)) throw unauthorized();
  }

  /** Every minute: free lapsed holds, send queued pushes/refunds, promote eligible commission. */
  @Get('minute')
  async minute(@Headers('authorization') auth?: string) {
    this.check(auth);
    await this.bookings.expireHolds(true);
    let jobs = 0;
    while (jobs < 50 && (await this.jobs.runOne())) jobs++;
    await this.ledger.promoteEligible(true);
    return { ok: true, jobs };
  }

  /** Daily 01:30 IST: 70:30 matching run. */
  @Get('daily')
  async daily(@Headers('authorization') auth?: string) {
    this.check(auth);
    await this.ledger.runMatching(true);
    return { ok: true };
  }
}
