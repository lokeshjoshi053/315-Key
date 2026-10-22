import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Inject, Injectable, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { randomInt } from 'crypto';
import { CONFIG, Config } from '../config';
import { Db, Queryable } from '../db';
import { AuthUser, CurrentUser } from '../common/auth';
import { badRequest, conflict, forbidden, maskMobile, notFound, PageQuery } from '../common/http';
import { Audit, Settings } from '../common/support';
import { NotificationService } from '../notify/notifications';
import { PoolClient } from 'pg';

export interface UserRow {
  id: string;
  role: 'USER' | 'ADMIN';
  mobile: string | null;
  email: string | null;
  name: string | null;
  address: string | null;
  partnerStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  sponsorId: string | null;
  leg: 'L' | 'R' | null;
  referralCode: string | null;
  active: boolean;
  createdAt: Date;
}

const USER_COLS = `id, role, mobile, email, name, address, partner_status, sponsor_id, leg, referral_code, active, created_at`;
export const MOBILE_RE = /^[6-9]\d{9}$/;

@Injectable()
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly notify: NotificationService,
  ) {}

  /** Partner decision by an admin. Shared by the admin API and the app (v1) approvals screen. */
  async partnerAction(c: PoolClient, actorId: string, userId: string, action: 'APPROVE' | 'REJECT' | 'SUSPEND', note?: string) {
    const allowed = {
      APPROVE: { from: ['PENDING', 'SUSPENDED', 'REJECTED'], to: 'APPROVED' },
      REJECT: { from: ['PENDING'], to: 'REJECTED' },
      SUSPEND: { from: ['APPROVED'], to: 'SUSPENDED' },
    } as const;
    const before = await this.db.maybe<{ partnerStatus: string; referralCode: string | null }>('select partner_status, referral_code from app_user where id = $1 for update', [userId], c);
    if (!before) throw notFound('User');
    const rule = allowed[action];
    if (!(rule.from as readonly string[]).includes(before.partnerStatus)) throw conflict('INVALID_STATE', `Cannot ${action.toLowerCase()} a ${before.partnerStatus} partner`);
    const code = rule.to === 'APPROVED' && !before.referralCode ? await this.newReferralCode(c) : before.referralCode;
    await c.query('update app_user set partner_status = $2, referral_code = $3, updated_at = now() where id = $1', [userId, rule.to, code]);
    await this.audit.log(c, actorId, `PARTNER_${action}`, 'user', userId, before, { partnerStatus: rule.to, note });
    const msg = { APPROVED: 'Your partner account is approved. Start sharing your referral code!', REJECTED: 'Your partner application was not approved.', SUSPENDED: 'Your partner account has been suspended.' }[rule.to];
    await this.notify.notify(c, userId, 'ACCOUNT', 'Partner status updated', note ? `${msg} ${note}` : msg, 'partner');
    return { partnerStatus: rule.to, referralCode: code };
  }

  async get(id: string, q?: Queryable): Promise<UserRow> {
    const u = await this.db.maybe<UserRow>(`select ${USER_COLS} from app_user where id = $1`, [id], q);
    if (!u) throw notFound('User');
    return u;
  }

  findBy(col: 'mobile' | 'email' | 'google_sub', value: string, q?: Queryable) {
    return this.db.maybe<UserRow>(`select ${USER_COLS} from app_user where ${col} = $1`, [value], q);
  }

  async requirePartner(id: string, q?: Queryable) {
    const u = await this.get(id, q);
    if (u.partnerStatus !== 'APPROVED') throw forbidden('PARTNER_NOT_APPROVED', 'Partner approval is required');
    return u;
  }

  /** Creates a USER. Sponsor comes from the referral code, else from a partner's registered lead. */
  async create(
    q: Queryable,
    fields: { mobile?: string; email?: string; googleSub?: string; name?: string },
    referralCode?: string,
    leg?: 'L' | 'R',
  ): Promise<UserRow> {
    let sponsorId: string | null = null;
    if (referralCode) {
      sponsorId = (await this.approvedPartnerByCode(referralCode, q)).id;
    }
    const user = await this.db.one<UserRow>(
      `insert into app_user (mobile, email, google_sub, name) values ($1, $2, $3, $4) returning ${USER_COLS}`,
      [fields.mobile ?? null, fields.email ?? null, fields.googleSub ?? null, fields.name ?? null],
      q,
    );
    if (!sponsorId && fields.mobile) {
      const lead = await this.db.maybe<{ partnerId: string }>(
        `select l.partner_id from lead l join app_user p on p.id = l.partner_id
         where l.mobile = $1 and l.converted_user_id is null and p.partner_status = 'APPROVED'
         order by l.created_at limit 1`,
        [fields.mobile],
        q,
      );
      sponsorId = lead?.partnerId ?? null;
    }
    if (sponsorId) await this.attachSponsor(q, user.id, sponsorId, leg);
    if (fields.mobile) {
      await this.db.exec(
        'update lead set converted_user_id = $1 where mobile = $2 and converted_user_id is null',
        [user.id, fields.mobile],
        q,
      );
    }
    return this.get(user.id, q);
  }

  async approvedPartnerByCode(code: string, q?: Queryable) {
    const s = await this.db.maybe<{ id: string }>(
      `select id from app_user where referral_code = $1 and partner_status = 'APPROVED' and active`,
      [code.trim().toUpperCase()],
      q,
    );
    if (!s) throw badRequest('INVALID_REFERRAL', 'Referral code is invalid');
    return s;
  }

  /**
   * Places the user under a sponsor on leg L or R.
   * ponytail: with no explicit leg, auto-balance to the sponsor's leg with fewer direct recruits.
   * Placement rule is open business question A-4; change here only.
   */
  async attachSponsor(q: Queryable, userId: string, sponsorId: string, leg?: 'L' | 'R') {
    if (sponsorId === userId) throw badRequest('INVALID_SPONSOR', 'You cannot sponsor yourself');
    const cycle = await this.db.maybe(
      `with recursive up(id, sponsor_id, depth) as (
         select id, sponsor_id, 0 from app_user where id = $1
         union all select u.id, u.sponsor_id, up.depth + 1 from app_user u join up on u.id = up.sponsor_id where up.depth < 1000)
       select 1 from up where id = $2`,
      [sponsorId, userId],
      q,
    );
    if (cycle) throw badRequest('INVALID_SPONSOR', 'Sponsor is in your own network');
    if (!leg) {
      const c = await this.db.one<{ l: number; r: number }>(
        `select count(*) filter (where leg = 'L') as l, count(*) filter (where leg = 'R') as r from app_user where sponsor_id = $1`,
        [sponsorId],
        q,
      );
      leg = c.l <= c.r ? 'L' : 'R';
    }
    const n = await this.db.exec(
      'update app_user set sponsor_id = $2, leg = $3, updated_at = now() where id = $1 and sponsor_id is null',
      [userId, sponsorId, leg],
      q,
    );
    if (!n) throw conflict('SPONSOR_ALREADY_SET', 'Sponsor is already set');
  }

  async newReferralCode(q: Queryable): Promise<string> {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
    for (;;) {
      const code = 'P' + Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
      const taken = await this.db.maybe('select 1 from app_user where referral_code = $1', [code], q);
      if (!taken) return code;
    }
  }
}

// ---------- DTOs ----------

export class UpdateProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
}

export class NomineeDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsString() @IsNotEmpty() @MaxLength(50) relation: string;
  @IsOptional() @Matches(/^[6-9]\d{9}$/) mobile?: string;
}

export class DeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(4096) token: string;
  @IsIn(['android', 'ios']) platform: 'android' | 'ios';
}

export class SponsorDto {
  @IsString() @IsNotEmpty() @MaxLength(20) referralCode: string;
  @IsOptional() @IsIn(['L', 'R']) leg?: 'L' | 'R';
}

export class LeadDto {
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a valid 10-digit Indian number' }) mobile: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class NetworkQuery extends PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3) level = 0;
}

// ---------- Controllers ----------

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly db: Db,
    private readonly settings: Settings,
  ) {}

  /** C01/A01 splash routing. */
  @Get('bootstrap')
  async bootstrap(@CurrentUser() u: AuthUser) {
    const user = await this.users.get(u.id);
    return {
      user,
      profileComplete: !!user.name,
      minAppVersion: await this.settings.get('min_app_version'),
      bookingsEnabled: await this.settings.bool('bookings_enabled'),
      support: { phone: await this.settings.get('support_phone'), email: await this.settings.get('support_email') },
    };
  }

  @Get()
  async me(@CurrentUser() u: AuthUser) {
    const user = await this.users.get(u.id);
    const nominee = await this.db.maybe('select name, relation, mobile from nominee where user_id = $1', [u.id]);
    return { ...user, nominee };
  }

  @Put()
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    await this.db.exec(
      'update app_user set name = $2, email = coalesce($3, email), address = $4, updated_at = now() where id = $1',
      [u.id, dto.name.trim(), dto.email?.toLowerCase() ?? null, dto.address ?? null],
    );
    return this.me(u);
  }

  @Put('nominee')
  async nominee(@CurrentUser() u: AuthUser, @Body() dto: NomineeDto) {
    await this.db.exec(
      `insert into nominee (user_id, name, relation, mobile) values ($1, $2, $3, $4)
       on conflict (user_id) do update set name = excluded.name, relation = excluded.relation, mobile = excluded.mobile`,
      [u.id, dto.name, dto.relation, dto.mobile ?? null],
    );
    return this.me(u);
  }

  @Post('devices')
  async device(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    await this.db.exec(
      `insert into device_token (token, user_id, platform) values ($1, $2, $3)
       on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now()`,
      [dto.token, u.id, dto.platform],
    );
    return { ok: true };
  }

  /** For users who signed up without a code. Locked once they have booked (FR-2.2). */
  @Put('sponsor')
  async sponsor(@CurrentUser() u: AuthUser, @Body() dto: SponsorDto) {
    await this.db.tx(async (c) => {
      const booked = await this.db.maybe('select 1 from booking where user_id = $1 limit 1', [u.id], c);
      if (booked) throw conflict('SPONSOR_LOCKED', 'Sponsor cannot change after a booking');
      const s = await this.users.approvedPartnerByCode(dto.referralCode, c);
      await this.users.attachSponsor(c, u.id, s.id, dto.leg);
    });
    return this.me(u);
  }
}

@ApiTags('Partner')
@ApiBearerAuth()
@Controller()
export class PartnerController {
  constructor(
    private readonly users: UsersService,
    private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  @Post('partners/apply')
  async apply(@CurrentUser() u: AuthUser) {
    const user = await this.users.get(u.id);
    if (!user.name) throw badRequest('PROFILE_INCOMPLETE', 'Complete your profile first');
    const n = await this.db.exec(
      `update app_user set partner_status = 'PENDING', updated_at = now() where id = $1 and partner_status in ('NONE', 'REJECTED')`,
      [u.id],
    );
    if (!n) throw conflict('INVALID_STATE', `Partner status is ${user.partnerStatus}`);
    return { partnerStatus: 'PENDING' };
  }

  @Get('partners/me')
  async partnerMe(@CurrentUser() u: AuthUser) {
    const user = await this.users.get(u.id);
    const counts = await this.db.one<{ l: number; r: number }>(
      `select count(*) filter (where leg = 'L') as l, count(*) filter (where leg = 'R') as r from app_user where sponsor_id = $1`,
      [u.id],
    );
    return {
      partnerStatus: user.partnerStatus,
      referralCode: user.partnerStatus === 'APPROVED' ? user.referralCode : null,
      referralLink: user.partnerStatus === 'APPROVED' ? this.cfg.referralLinkBase + user.referralCode : null,
      directLeft: counts.l,
      directRight: counts.r,
    };
  }

  /** A08: 3-level network. `side` is which of MY legs the member sits in. */
  @Get('partners/network')
  async network(@CurrentUser() u: AuthUser, @Query() q: NetworkQuery) {
    await this.users.requirePartner(u.id);
    const cte = `with recursive down as (
        select id, name, mobile, partner_status, created_at, leg as side, 1 as level from app_user where sponsor_id = $1
        union all
        select c.id, c.name, c.mobile, c.partner_status, c.created_at, d.side, d.level + 1
        from app_user c join down d on c.sponsor_id = d.id where d.level < 3)`;
    const rows = await this.db.many<any>(
      `${cte} select d.*, exists (select 1 from booking b where b.user_id = d.id and b.status = 'CONFIRMED') as has_booking
       from down d where ($2 = 0 or d.level = $2) order by d.level, d.created_at limit $3 offset $4`,
      [u.id, q.level, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>(
      `${cte} select count(*) as total from down where ($2 = 0 or level = $2)`,
      [u.id, q.level],
    );
    return {
      items: rows.map((r) => ({ ...r, mobile: maskMobile(r.mobile) })),
      page: q.page,
      size: q.size,
      total,
    };
  }

  @Post('leads')
  async createLead(@CurrentUser() u: AuthUser, @Body() dto: LeadDto) {
    await this.users.requirePartner(u.id);
    const existing = await this.users.findBy('mobile', dto.mobile);
    if (existing) throw conflict('ALREADY_REGISTERED', 'This mobile number already has an account');
    return this.db.one(
      `insert into lead (partner_id, name, mobile, note) values ($1, $2, $3, $4) returning *`,
      [u.id, dto.name, dto.mobile, dto.note ?? null],
    );
  }

  /** A07 pipeline: NEW → REGISTERED → BOOKED. */
  @Get('leads')
  async leads(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    await this.users.requirePartner(u.id);
    const items = await this.db.many(
      `select l.id, l.name, l.mobile, l.note, l.created_at,
              case when exists (select 1 from booking b where b.user_id = l.converted_user_id and b.status = 'CONFIRMED') then 'BOOKED'
                   when l.converted_user_id is not null then 'REGISTERED' else 'NEW' end as status
       from lead l where l.partner_id = $1 order by l.created_at desc limit $2 offset $3`,
      [u.id, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from lead where partner_id = $1', [u.id]);
    return { items, page: q.page, size: q.size, total };
  }
}
