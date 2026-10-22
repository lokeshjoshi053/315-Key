/**
 * Mobile app API (v1): the exact endpoints and response shapes the Kotlin app
 * (com.example.housingroperty, ApiConfig.Endpoints) expects, under /api/v1.
 * Thin adapter: all business rules stay in the core services; this layer only
 * maps requests in and reshapes responses into the app's display models.
 */
import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { Response } from 'express';
import { CONFIG, Config } from '../config';
import { Db } from '../db';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth';
import { ApiException, badRequest, conflict, notFound } from '../common/http';
import { Crypto, Settings } from '../common/support';
import { AuthService, TokenService } from '../auth/auth';
import { BookingService } from '../booking/booking';
import { PayoutService } from '../payout/payouts';
import { UsersService } from '../users/users';
import { day, inr, inrShort, label, mapOffset, pct, timeAgo } from './format';

const MOBILE = /^[6-9]\d{9}$/;
const AGENT_ROLE = (u: { role: string; partnerStatus: string }) => (u.role === 'ADMIN' ? 'ADMIN' : u.partnerStatus === 'APPROVED' ? 'AGENT' : 'CUSTOMER');

// ---------- shared mappers ----------

@Injectable()
export class AppV1Mapper {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  private async defaults() {
    const [location, road, image] = await Promise.all(['project_location', 'default_road_width', 'default_plot_image_url'].map((k) => this.settings.get(k)));
    return { location, road, image };
  }

  async plots(where = 'true', params: unknown[] = []) {
    const rows = await this.db.many<any>(
      `select id, plot_no, block, facing, area_sqft, price_paise, lat, lng, road_width, image_url, location,
              case when status = 'HELD' and held_until < now() then 'AVAILABLE' else status end as status
       from plot where ${where} order by plot_no`,
      params,
    );
    const d = await this.defaults();
    return rows.map((r) => {
      const off = mapOffset(r.plotNo);
      return {
        id: r.id,
        title: `Plot ${r.plotNo}`,
        block: r.block ?? '',
        facing: r.facing ?? '',
        location: r.location ?? d.location,
        sizeSqFt: r.areaSqft ? `${new Intl.NumberFormat('en-IN').format(r.areaSqft)} sq ft` : '',
        pricePerSqFt: r.areaSqft ? `${inr(r.pricePaise / r.areaSqft)}/sq ft` : '',
        roadWidth: r.roadWidth ?? d.road,
        totalPriceFormatted: inr(r.pricePaise),
        status: ({ AVAILABLE: 'AVAILABLE', HELD: 'ON_HOLD', BOOKED: 'BOOKED', BLOCKED: 'ON_HOLD' } as Record<string, string>)[r.status] ?? 'ON_HOLD',
        imageUrl: r.imageUrl ?? d.image,
        latitude: r.lat ?? 0,
        longitude: r.lng ?? 0,
        mapOffsetX: off.x,
        mapOffsetY: off.y,
      };
    });
  }

  /** The app's Booking model with its 4-step milestone tracker. */
  async booking(where: string, params: unknown[]) {
    const b = await this.db.maybe<any>(
      `select b.id, b.internal_ref, b.status, b.amount_paise, b.created_at, b.confirmed_at, b.hold_expires_at,
              p.id as plot_id, p.plot_no, p.block, p.area_sqft, p.location, t.name as tier_name,
              (select provider_payment_id from payment where booking_id = b.id and status in ('VERIFIED','REFUND_PENDING','REFUNDED') order by verified_at desc limit 1) as txn_id,
              (select status from document where booking_id = b.id and type = 'AGREEMENT' order by created_at desc limit 1) as agreement,
              (select status from document where booking_id = b.id and type = 'ALLOTMENT' order by created_at desc limit 1) as allotment
       from booking b join plot p on p.id = b.plot_id join tier t on t.id = b.tier_id
       where ${where} order by b.created_at desc limit 1`,
      params,
    );
    if (!b) return null;
    const d = await this.defaults();
    const paid = b.status === 'CONFIRMED';
    const steps = [
      { title: 'Plot reserved', subtitle: `Plot ${b.plotNo} held for you`, done: true, active: false },
      { title: 'Payment', subtitle: paid ? `${inr(b.amountPaise)} received` : b.status === 'PENDING_PAYMENT' ? `Pay ${inr(b.amountPaise)} before ${day(b.holdExpiresAt)}` : label(b.status), done: paid, active: b.status === 'PENDING_PAYMENT' },
      { title: 'Agreement', subtitle: b.agreement ? `Agreement ${label(b.agreement).toLowerCase()}` : 'Shared after payment', done: b.agreement === 'SIGNED', active: paid && b.agreement !== 'SIGNED' },
      { title: 'Allotment', subtitle: b.allotment ? 'Allotment letter issued' : 'After agreement', done: !!b.allotment, active: b.agreement === 'SIGNED' && !b.allotment },
    ];
    const milestones = steps.map((s, i) => ({
      step: i + 1,
      title: s.title,
      subtitle: s.subtitle,
      status: s.done ? 'COMPLETED' : s.active ? 'IN_PROGRESS' : 'UPCOMING',
      badgeLabel: s.done ? 'Done' : s.active ? 'In progress' : 'Upcoming',
    }));
    const current = milestones.find((m) => m.status !== 'COMPLETED') ?? milestones[milestones.length - 1];
    return {
      plotId: b.plotId,
      plotTitle: `Plot ${b.plotNo}`,
      block: b.block ?? '',
      location: b.location ?? d.location,
      sizeSqFt: b.areaSqft ? `${new Intl.NumberFormat('en-IN').format(b.areaSqft)} sq ft` : '',
      planName: b.tierName,
      amountFormatted: inr(b.amountPaise),
      orderId: b.internalRef,
      txnId: b.txnId ?? '',
      stepText: `Step ${current.step} of ${milestones.length}`,
      stepSummary: `${current.title}: ${current.badgeLabel.toLowerCase()}`,
      milestones,
      // extra (not in the app model yet): needed to show booking state and act on it
      bookingId: b.id,
      status: b.status,
    };
  }

  async partnerProfile(userId: string) {
    const u = await this.db.one<any>(
      `select u.name, u.mobile, u.email, u.referral_code, u.partner_status,
              b.ifsc, b.account_last4, b.pan_last4, a.ifsc as app_ifsc, a.account_last4 as app_account_last4, a.pan_last4 as app_pan_last4
       from app_user u left join beneficiary b on b.user_id = u.id left join partner_application a on a.user_id = u.id where u.id = $1`,
      [userId],
    );
    const base = await this.settings.get('project_location');
    const ifsc = u.ifsc ?? u.appIfsc, acct = u.accountLast4 ?? u.appAccountLast4, pan = u.panLast4 ?? u.appPanLast4;
    return {
      fullName: u.name ?? '',
      phone: u.mobile ?? '',
      email: u.email ?? '',
      agentCode: u.referralCode ?? '',
      referralLink: u.referralCode ? `${this.cfg.referralLinkBase}${u.referralCode}` : '',
      roleTitle: u.partnerStatus === 'APPROVED' ? `Partner · ${base}` : 'Partner applicant',
      status: { NONE: 'Not applied', PENDING: 'Pending approval', APPROVED: 'Approved', REJECTED: 'Rejected', SUSPENDED: 'Suspended' }[u.partnerStatus as string] ?? u.partnerStatus,
      panDocument: pan ? `******${pan}` : '',
      bankAccount: acct ? `${ifsc} · ****${acct}` : '',
    };
  }

  async userProfile(userId: string) {
    const u = await this.db.one<any>(
      `select u.name, u.mobile, u.email, u.partner_status, n.name as nominee_name from app_user u left join nominee n on n.user_id = u.id where u.id = $1`,
      [userId],
    );
    return { fullName: u.name ?? '', phone: u.mobile ?? '', email: u.email ?? '', nomineeName: u.nomineeName ?? '', roleTitle: u.partnerStatus === 'APPROVED' ? 'Customer & Partner' : 'Customer' };
  }

  async commissions(where: string, params: unknown[]) {
    const rows = await this.db.many<any>(
      `select v.id, v.kind, v.level, v.gross_paise, v.admin_paise, v.tds_paise, v.net_paise, v.status, v.created_at, v.reverses_id,
              b.internal_ref as booking_ref, p.plot_no, t.name as tier_name, b.l1_bps, b.l2_bps, b.l3_bps
       from ledger_view v left join booking b on b.id = v.source_booking_id left join plot p on p.id = b.plot_id left join tier t on t.id = b.tier_id
       where ${where} order by v.created_at desc limit 200`,
      params,
    );
    const bonus = await this.settings.int('matching_bonus_bps');
    return rows.map((r) => ({
      id: r.id,
      title: r.kind === 'MATCHING' ? 'Matching bonus' : `${r.reversesId ? 'Reversal · ' : ''}Level ${r.level} commission`,
      source: r.kind === 'MATCHING' ? `Daily 70:30 matching · ${day(r.createdAt)}` : `${r.bookingRef} · Plot ${r.plotNo} · ${r.tierName}`,
      levelRate: r.kind === 'MATCHING' ? pct(bonus) : pct([r.l1Bps, r.l2Bps, r.l3Bps][r.level - 1] ?? 0),
      gross: inr(r.grossPaise),
      adminDeduction: inr(r.adminPaise),
      tdsDeduction: inr(r.tdsPaise),
      net: inr(r.netPaise),
      statusBadge: label(r.status),
    }));
  }
}

// ---------- DTOs (field names chosen for the app's Retrofit calls) ----------

export class V1PhoneDto {
  @Matches(/^[6-9]\d{9}$/, { message: 'phone must be a valid 10-digit Indian number' }) phone: string;
}
export class V1VerifyOtpDto {
  @Matches(/^[6-9]\d{9}$/, { message: 'phone must be a valid 10-digit Indian number' }) phone: string;
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' }) otp: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
}
export class V1GoogleDto {
  @IsString() @IsNotEmpty() idToken: string;
}
export class V1LogoutDto {
  @IsOptional() @IsString() refreshToken?: string;
}
export class V1CreateBookingDto {
  @IsUUID() plotId: string;
  @IsUUID() planId: string;
}
export class V1CustomerProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(100) fullName: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() @MaxLength(100) nomineeName?: string;
}
export class V1AgentProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(100) fullName: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
}
export class V1KycDto {
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'pan is invalid' }) pan: string;
  @Matches(/^\d{9,18}$/, { message: 'accountNumber must be 9–18 digits' }) accountNumber: string;
  @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'ifsc is invalid' }) ifsc: string;
}
export class V1LeadDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @Matches(/^[6-9]\d{9}$/, { message: 'phone must be a valid 10-digit Indian number' }) phone: string;
  @IsOptional() @IsString() @MaxLength(200) plotInterested?: string;
}

// ---------- Auth ----------

/** Auth endpoints answer with the app's AuthResult; failures are success:false with errorMessage. */
@ApiTags('App v1')
@Public()
@Controller('api/v1/auth')
export class AppV1AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
  ) {}

  private fail(e: unknown, res: Response) {
    if (e instanceof ApiException) {
      res.status(e.getStatus() === 429 ? 429 : 200);
      return { success: false, token: null, role: null, errorMessage: e.message, code: e.code };
    }
    throw e;
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('send-otp')
  @HttpCode(200)
  async sendOtp(@Body() d: V1PhoneDto, @Res({ passthrough: true }) res: Response) {
    try {
      const r = await this.auth.requestOtp(d.phone);
      return { success: true, token: null, role: null, errorMessage: null, ...r };
    } catch (e) {
      return this.fail(e, res);
    }
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('resend-otp')
  @HttpCode(200)
  resendOtp(@Body() d: V1PhoneDto, @Res({ passthrough: true }) res: Response) {
    return this.sendOtp(d, res);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(@Body() d: V1VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    try {
      const r = await this.auth.verifyOtp({ mobile: d.phone, code: d.otp, referralCode: d.referralCode });
      return this.result(r);
    } catch (e) {
      return this.fail(e, res);
    }
  }

  @Post('google-login')
  @HttpCode(200)
  async google(@Body() d: V1GoogleDto, @Res({ passthrough: true }) res: Response) {
    try {
      return this.result(await this.auth.google({ idToken: d.idToken }));
    } catch (e) {
      return this.fail(e, res);
    }
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() d: V1LogoutDto) {
    if (d.refreshToken) await this.tokens.revoke(d.refreshToken);
    return { success: true, token: null, role: null, errorMessage: null };
  }

  private async result(r: { accessToken: string; refreshToken: string; expiresIn: number; isNewUser: boolean; profileComplete: boolean }) {
    const sub = JSON.parse(Buffer.from(r.accessToken.split('.')[1], 'base64url').toString()).sub as string;
    const u = await this.users.get(sub);
    return { success: true, token: r.accessToken, role: AGENT_ROLE(u), errorMessage: null, refreshToken: r.refreshToken, expiresIn: r.expiresIn, isNewUser: r.isNewUser, profileComplete: r.profileComplete };
  }
}

// ---------- Customer ----------

@ApiTags('App v1')
@ApiBearerAuth()
@Controller('api/v1/customer')
export class AppV1CustomerController {
  constructor(
    private readonly db: Db,
    private readonly map: AppV1Mapper,
    private readonly bookings: BookingService,
    private readonly settings: Settings,
  ) {}

  @Get('plots')
  plots() {
    return this.map.plots();
  }

  @Get('plots/:id')
  async plot(@Param('id', ParseUUIDPipe) id: string) {
    const [p] = await this.map.plots('id = $1', [id]);
    if (!p) throw notFound('Plot');
    return p;
  }

  @Get('booking-plans')
  async plans() {
    const popular = await this.settings.get('popular_tier_code');
    const rows = await this.db.many<any>('select id, code, name, amount_paise from tier where active order by sort');
    return rows.map((t) => ({ id: t.id, name: t.name, amount: t.amountPaise, amountFormatted: inr(t.amountPaise), isPopular: t.code === popular }));
  }

  /** Starts checkout. Returns the app's Booking plus `checkout` for Razorpay. */
  @Post('bookings')
  async createBooking(@CurrentUser() u: AuthUser, @Body() d: V1CreateBookingDto) {
    const checkout = await this.bookings.create(u.id, { plotId: d.plotId, tierId: d.planId, termsAccepted: true });
    const booking = await this.map.booking('b.id = $1', [checkout.bookingId]);
    return { ...booking, checkout };
  }

  @Get('bookings/active')
  async activeBooking(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const b = await this.map.booking(`b.user_id = $1 and b.status in ('PENDING_PAYMENT','CONFIRMED','REFUND_PENDING')`, [u.id]);
    if (!b) res.status(204);
    return b ?? undefined;
  }

  @Get('payments')
  async payments(@CurrentUser() u: AuthUser) {
    const rows = await this.db.many<any>(
      `select p.id, p.internal_ref, p.amount_paise, p.status, p.verified_at, p.created_at from payment p
       where p.user_id = $1 and p.status <> 'CREATED' order by p.created_at desc limit 200`,
      [u.id],
    );
    const badge: Record<string, string> = { PENDING: 'Pending', VERIFIED: 'Verified', FAILED: 'Failed', REFUND_PENDING: 'Refund pending', REFUNDED: 'Refunded' };
    return rows.map((p) => ({ id: p.id, amountFormatted: inr(p.amountPaise), dateOrSubtitle: `${day(p.verifiedAt ?? p.createdAt)} · ${p.internalRef}`, statusBadge: badge[p.status] ?? label(p.status) }));
  }

  @Get('documents')
  async documents(@CurrentUser() u: AuthUser) {
    const rows = await this.db.many<any>('select id, type, title, status, created_at from document where user_id = $1 order by created_at desc limit 200', [u.id]);
    return rows.map((d) => ({ id: d.id, title: d.title, subtitle: `${label(d.type)} · ${day(d.createdAt)}`, statusBadge: d.status === 'SENT' && d.type === 'AGREEMENT' ? 'Action needed' : label(d.status), isActionNeeded: d.status === 'SENT' && d.type === 'AGREEMENT' }));
  }

  @Get('notifications')
  async notifications(@CurrentUser() u: AuthUser) {
    const rows = await this.db.many<any>('select id, category, title, created_at from notification where user_id = $1 order by created_at desc limit 100', [u.id]);
    return rows.map((n) => ({ id: n.id, title: n.title, timeAgo: timeAgo(n.createdAt), iconType: n.category.toLowerCase() }));
  }

  @Get('profile')
  profile(@CurrentUser() u: AuthUser) {
    return this.map.userProfile(u.id);
  }

  @Put('profile')
  async saveProfile(@CurrentUser() u: AuthUser, @Body() d: V1CustomerProfileDto) {
    await this.db.tx(async (c) => {
      const me = await this.db.one<{ mobile: string | null }>('select mobile from app_user where id = $1', [u.id], c);
      if (d.phone && me.mobile && d.phone !== me.mobile) throw badRequest('PHONE_CHANGE_NOT_ALLOWED', 'Mobile number is your login and cannot be changed here');
      await c.query('update app_user set name = $2, email = coalesce(nullif($3, \'\'), email), updated_at = now() where id = $1', [u.id, d.fullName.trim(), d.email?.toLowerCase() ?? null]);
      if (d.nomineeName?.trim()) {
        await c.query(
          `insert into nominee (user_id, name, relation) values ($1, $2, 'Nominee') on conflict (user_id) do update set name = excluded.name`,
          [u.id, d.nomineeName.trim()],
        );
      }
    });
    return this.map.userProfile(u.id);
  }

  @Get('referrer')
  async referrer(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.db.maybe<any>(
      `select s.referral_code, s.name as sponsor_name, me.name as my_name,
              exists (select 1 from booking b where b.user_id = me.id and b.status = 'CONFIRMED') as booked
       from app_user me join app_user s on s.id = me.sponsor_id where me.id = $1`,
      [u.id],
    );
    if (!r) {
      res.status(204);
      return undefined;
    }
    return { agentCode: r.referralCode ?? '', agentName: r.sponsorName ?? '', agentRole: 'Partner', customerName: r.myName ?? '', customerStatus: r.booked ? 'Booked' : 'Registered' };
  }
}

// ---------- Agent (partner) ----------

@ApiTags('App v1')
@ApiBearerAuth()
@Controller('api/v1/agent')
export class AppV1AgentController {
  constructor(
    private readonly db: Db,
    private readonly map: AppV1Mapper,
    private readonly users: UsersService,
    private readonly crypto: Crypto,
    private readonly settings: Settings,
  ) {}

  private available(userId: string) {
    return this.db.one<{ v: number }>(
      `select coalesce(sum(net_paise), 0) as v from ledger_view v where v.user_id = $1 and v.status = 'APPROVED'
       and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)`,
      [userId],
    );
  }

  @Get('dashboard/stats')
  async dashboard(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const s = await this.db.one<any>(
      `select (select count(*) from lead where partner_id = $1) as leads,
              (select count(*) from lead l where l.partner_id = $1 and not exists (select 1 from booking b where b.user_id = l.converted_user_id and b.status = 'CONFIRMED')) as active_leads,
              (select count(distinct source_booking_id) from ledger_entry where user_id = $1 and kind = 'COMMISSION' and reverses_id is null) as bookings,
              (select coalesce(sum(net_paise), 0) from ledger_view where user_id = $1 and status <> 'REVERSED') as net,
              (select coalesce(sum(matched_paise), 0) from match_run where user_id = $1) as matched`,
      [u.id],
    );
    return {
      leadsCount: String(s.leads),
      activeLeadsCount: s.activeLeads,
      bookingsCount: String(s.bookings),
      netCommission: inr(s.net),
      payoutDue: inr((await this.available(u.id)).v),
      matchedVolume: inr(s.matched),
    };
  }

  @Get('profile')
  profile(@CurrentUser() u: AuthUser) {
    return this.map.partnerProfile(u.id);
  }

  @Put('profile')
  async updateProfile(@CurrentUser() u: AuthUser, @Body() d: V1AgentProfileDto) {
    const me = await this.users.get(u.id);
    if (d.phone && me.mobile && d.phone !== me.mobile) throw badRequest('PHONE_CHANGE_NOT_ALLOWED', 'Mobile number is your login and cannot be changed here');
    await this.db.exec(
      `update app_user set name = $2, email = coalesce(nullif($3, ''), email), address = coalesce(nullif($4, ''), address), updated_at = now() where id = $1`,
      [u.id, d.fullName.trim(), d.email?.toLowerCase() ?? null, d.address ?? null],
    );
    return this.map.partnerProfile(u.id);
  }

  /** Partner onboarding: stores PAN + bank (encrypted) and applies; bank is registered with Cashfree on approval. */
  @Post('onboarding/kyc')
  async kyc(@CurrentUser() u: AuthUser, @Body() d: V1KycDto) {
    const me = await this.users.get(u.id);
    if (!me.name) throw badRequest('PROFILE_INCOMPLETE', 'Complete your profile first');
    if (me.partnerStatus === 'APPROVED' || me.partnerStatus === 'SUSPENDED') throw conflict('INVALID_STATE', `Partner status is ${me.partnerStatus}`);
    await this.db.tx(async (c) => {
      await c.query(
        `insert into partner_application (user_id, holder_name, pan_enc, pan_last4, account_enc, account_last4, ifsc) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id) do update set holder_name = excluded.holder_name, pan_enc = excluded.pan_enc, pan_last4 = excluded.pan_last4,
           account_enc = excluded.account_enc, account_last4 = excluded.account_last4, ifsc = excluded.ifsc, submitted_at = now()`,
        [u.id, me.name, this.crypto.encrypt(d.pan), d.pan.slice(-4), this.crypto.encrypt(d.accountNumber), d.accountNumber.slice(-4), d.ifsc],
      );
      await c.query(`update app_user set partner_status = 'PENDING', updated_at = now() where id = $1 and partner_status in ('NONE', 'REJECTED')`, [u.id]);
    });
    return this.map.partnerProfile(u.id);
  }

  @Get('leads')
  async leads(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const rows = await this.db.many<any>(
      `select l.id, l.name, l.mobile, l.note, l.created_at,
              case when exists (select 1 from booking b where b.user_id = l.converted_user_id and b.status = 'CONFIRMED') then 'Booked'
                   when l.converted_user_id is not null then 'Registered' else 'New' end as badge
       from lead l where l.partner_id = $1 order by l.created_at desc limit 500`,
      [u.id],
    );
    return rows.map((l) => ({ id: l.id, name: l.name, phone: l.mobile, plotInterested: l.note ?? '', statusBadge: l.badge, subtitle: `Added ${day(l.createdAt)}` }));
  }

  @Post('leads/register')
  async registerLead(@CurrentUser() u: AuthUser, @Body() d: V1LeadDto) {
    await this.users.requirePartner(u.id);
    if (await this.users.findBy('mobile', d.phone)) throw conflict('ALREADY_REGISTERED', 'This mobile number already has an account');
    const l = await this.db.one<any>('insert into lead (partner_id, name, mobile, note) values ($1, $2, $3, $4) returning id, name, mobile, note, created_at', [u.id, d.name, d.phone, d.plotInterested ?? null]);
    return { id: l.id, name: l.name, phone: l.mobile, plotInterested: l.note ?? '', statusBadge: 'New', subtitle: `Added ${day(l.createdAt)}` };
  }

  private team(userId: string) {
    return this.db.many<any>(
      `with recursive down as (
         select id, sponsor_id, name, leg, partner_status, created_at, 1 as level from app_user where sponsor_id = $1
         union all select c.id, c.sponsor_id, c.name, c.leg, c.partner_status, c.created_at, d.level + 1 from app_user c join down d on c.sponsor_id = d.id where d.level < 3)
       select d.*, exists (select 1 from booking b where b.user_id = d.id and b.status = 'CONFIRMED') as booked from down d order by level, created_at limit 1000`,
      [userId],
    );
  }

  @Get('network/levels')
  async levels(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const team = await this.team(u.id);
    return [1, 2, 3].map((level) => ({ level, membersCount: team.filter((m) => m.level === level).length }));
  }

  @Get('network/tree')
  async tree(@CurrentUser() u: AuthUser) {
    const me = await this.users.requirePartner(u.id);
    const team = await this.team(u.id);
    const node = (m: any): any => ({
      id: m.id,
      name: m.name ?? 'New member',
      subtitle: `${m.leg === 'R' ? 'Right' : 'Left'} leg · Joined ${day(m.createdAt)}`,
      badgeText: m.booked ? 'Booked' : m.partnerStatus === 'APPROVED' ? 'Partner' : 'Customer',
      level: m.level,
      children: team.filter((c) => c.sponsorId === m.id).map(node),
    });
    return {
      id: me.id,
      name: me.name ?? 'You',
      subtitle: `Code ${me.referralCode ?? ''}`,
      badgeText: 'You',
      level: 0,
      children: team.filter((m) => m.level === 1).map(node),
    };
  }

  @Get('commissions')
  async commissions(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    return this.map.commissions('v.user_id = $1', [u.id]);
  }

  @Get('commissions/:id')
  async commission(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [c] = await this.map.commissions('v.user_id = $1 and v.id = $2', [u.id, id]);
    if (!c) throw notFound('Commission');
    return c;
  }

  @Get('matching/summary')
  async matching(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const v = (await this.db.maybe<any>('select left_paise, right_paise from match_volume where user_id = $1', [u.id])) ?? { leftPaise: 0, rightPaise: 0 };
    const s = await this.db.one<any>(
      `select (select coalesce(sum(matched_paise), 0) from match_run where user_id = $1) as matched,
              coalesce(sum(gross_paise), 0) as gross, coalesce(sum(admin_paise), 0) as admin, coalesce(sum(net_paise), 0) as net
       from ledger_view where user_id = $1 and kind = 'MATCHING' and status <> 'REVERSED'`,
      [u.id],
    );
    const leftPower = v.leftPaise >= v.rightPaise;
    return {
      powerLeg: `${inr(leftPower ? v.leftPaise : v.rightPaise)} (${leftPower ? 'Left' : 'Right'})`,
      weakerLeg: `${inr(leftPower ? v.rightPaise : v.leftPaise)} (${leftPower ? 'Right' : 'Left'})`,
      matchedVolume: inr(s.matched),
      matchedVolShort: inrShort(s.matched),
      gross50: inr(s.gross),
      admin20: inr(s.admin),
      net: inr(s.net),
    };
  }

  @Get('payouts/info')
  async payoutInfo(@CurrentUser() u: AuthUser) {
    await this.users.requirePartner(u.id);
    const b = await this.db.maybe<any>('select ifsc, account_last4, status from beneficiary where user_id = $1', [u.id]);
    return {
      bankName: b ? `${b.ifsc.slice(0, 4)} ****${b.accountLast4}` : '',
      isVerified: b?.status === 'VERIFIED',
      nextPayoutAmount: inr((await this.available(u.id)).v),
      scheduledDate: await this.settings.get('payout_schedule'),
    };
  }

  @Get('notifications')
  async notifications(@CurrentUser() u: AuthUser) {
    const rows = await this.db.many<any>('select id, category, title, created_at from notification where user_id = $1 order by created_at desc limit 100', [u.id]);
    return rows.map((n) => ({ id: n.id, title: n.title, timeAgo: timeAgo(n.createdAt), type: n.category }));
  }
}

// ---------- Admin ----------

@ApiTags('App v1')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('api/v1/admin')
export class AppV1AdminController {
  constructor(
    private readonly db: Db,
    private readonly map: AppV1Mapper,
    private readonly users: UsersService,
    private readonly payouts: PayoutService,
  ) {}

  @Get('dashboard/stats')
  async stats() {
    const s = await this.db.one<any>(
      `select (select count(*) from plot) as total,
              (select count(*) from plot where status = 'BOOKED') as sold,
              (select count(*) from plot where status = 'AVAILABLE' or (status = 'HELD' and held_until < now())) as available,
              (select count(*) from app_user where partner_status = 'APPROVED' and active) as partners,
              (select count(*) from app_user where partner_status = 'PENDING') as pending,
              (select coalesce(sum(amount_paise), 0) from payment where status = 'VERIFIED') as revenue,
              (select coalesce(sum(net_paise), 0) from ledger_view v where v.status = 'APPROVED'
                 and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)) as payouts`,
    );
    return { totalPlots: s.total, plotsSold: s.sold, plotsAvailable: s.available, activePartners: s.partners, pendingApprovals: s.pending, totalRevenue: inr(s.revenue), pendingPayouts: inr(s.payouts) };
  }

  @Get('plots')
  plots() {
    return this.map.plots();
  }

  /** Pending partner applications (PARTNER_KYC). */
  @Get('approvals')
  async approvals() {
    const rows = await this.db.many<any>(
      `select u.id, u.name, u.mobile, u.updated_at, s.name as sponsor_name from app_user u left join app_user s on s.id = u.sponsor_id
       where u.partner_status = 'PENDING' order by u.updated_at limit 200`,
    );
    return rows.map((r) => ({ id: r.id, type: 'PARTNER_KYC', title: r.name ?? r.mobile, subtitle: `${r.mobile ?? ''}${r.sponsorName ? ` · referred by ${r.sponsorName}` : ''}`, status: 'Pending', submittedAt: timeAgo(r.updatedAt) }));
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.tx((c) => this.users.partnerAction(c, u.id, id, 'APPROVE'));
    await this.payouts.registerFromApplication(id);
    return { success: true, ...r };
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.tx((c) => this.users.partnerAction(c, u.id, id, 'REJECT'));
    return { success: true, ...r };
  }

  @Get('activity-logs')
  async logs() {
    const rows = await this.db.many<any>(
      'select a.id, a.action, a.entity, a.entity_id, a.created_at, u.name as actor from audit_log a left join app_user u on u.id = a.actor_id order by a.id desc limit 100',
    );
    return rows.map((r) => ({ id: String(r.id), title: label(r.action), description: `${r.actor ?? 'System'} · ${r.entity}${r.entityId ? ` ${String(r.entityId).slice(0, 8)}` : ''}`, timeAgo: timeAgo(r.createdAt) }));
  }

  /** Partners with approved commission to pay (id "pending:<userId>") plus recent payouts. */
  @Get('payouts')
  async payoutRequests() {
    const due = await this.db.many<any>(
      `select v.user_id, u.name, u.referral_code, sum(v.net_paise) as amount, b.ifsc, b.account_last4
       from ledger_view v join app_user u on u.id = v.user_id left join beneficiary b on b.user_id = v.user_id
       where v.status = 'APPROVED' and not exists (select 1 from payout_item pi where pi.ledger_entry_id = v.id and not pi.failed)
       group by v.user_id, u.name, u.referral_code, b.ifsc, b.account_last4 having sum(v.net_paise) > 0`,
    );
    const done = await this.db.many<any>(
      `select p.id, p.amount_paise, p.status, p.created_at, u.name, u.referral_code, b.ifsc, b.account_last4
       from payout p join app_user u on u.id = p.user_id left join beneficiary b on b.user_id = p.user_id order by p.created_at desc limit 100`,
    );
    const bank = (r: any) => (r.accountLast4 ? `${r.ifsc} · ****${r.accountLast4}` : 'Bank details missing');
    return [
      ...due.map((r) => ({ id: `pending:${r.userId}`, agentName: r.name ?? '', agentCode: r.referralCode ?? '', amount: inr(r.amount), bankDetails: bank(r), period: 'Due now', status: 'Pending' })),
      ...done.map((r) => ({ id: r.id, agentName: r.name ?? '', agentCode: r.referralCode ?? '', amount: inr(r.amountPaise), bankDetails: bank(r), period: day(r.createdAt), status: label(r.status) })),
    ];
  }

  @Post('payouts/:id/process')
  @HttpCode(200)
  async process(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const m = /^pending:([0-9a-f-]{36})$/.exec(id);
    if (!m) throw conflict('ALREADY_PROCESSED', 'This payout was already sent');
    const r = await this.payouts.createBatch(u.id, [m[1]]);
    if (!r.created) throw badRequest('NOTHING_TO_PAY', 'No approved amount above the minimum, or bank details are missing');
    return { success: r.results.every((x) => x.status !== 'FAILED'), ...r };
  }
}
