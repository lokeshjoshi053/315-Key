import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';
import { randomUUID } from 'crypto';
import { Db } from '../db';
import { AuthUser, CurrentUser, Roles } from '../common/auth';
import { badRequest, conflict, notFound, PageQuery } from '../common/http';
import { Audit, Settings } from '../common/support';
import { TokenService } from '../auth/auth';
import { BOOKING_VIEW, BookingService } from '../booking/booking';
import { Storage } from '../documents/documents';
import { LEDGER_STATUSES, LedgerService, LedgerStatus } from '../ledger/ledger';
import { NotificationService } from '../notify/notifications';
import { PayoutService } from '../payout/payouts';
import { PlotQuery, PlotsService } from '../plots/plots';
import { UsersService } from '../users/users';

// ---------- DTOs ----------

export class PlotDto {
  @IsString() @IsNotEmpty() @MaxLength(20) plotNo: string;
  @IsOptional() @IsString() @MaxLength(50) block?: string;
  @IsOptional() @IsString() @MaxLength(50) facing?: string;
  @IsOptional() @IsNumber() @IsPositive() areaSqft?: number;
  @IsInt() @IsPositive() pricePaise: number;
  @IsOptional() @IsLatitude() lat?: number;
  @IsOptional() @IsLongitude() lng?: number;
}

export class PlotUpdateDto extends PlotDto {
  @IsOptional() @IsIn(['AVAILABLE', 'BLOCKED']) status?: 'AVAILABLE' | 'BLOCKED';
}

export class TierDto {
  @IsString() @IsNotEmpty() @MaxLength(20) code: string;
  @IsString() @IsNotEmpty() @MaxLength(50) name: string;
  @IsInt() @IsPositive() amountPaise: number;
  @IsInt() @Min(0) @Max(10000) l1Bps: number;
  @IsInt() @Min(0) @Max(10000) l2Bps: number;
  @IsInt() @Min(0) @Max(10000) l3Bps: number;
  @IsOptional() @IsString() @MaxLength(2000) benefits?: string;
  @IsBoolean() active: boolean;
  @IsInt() @Min(0) sort: number;
}

export class UserQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(['USER', 'ADMIN']) role?: string;
  @IsOptional() @IsIn(['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']) partnerStatus?: string;
}

export class PartnerActionDto {
  @IsIn(['APPROVE', 'REJECT', 'SUSPEND']) action: 'APPROVE' | 'REJECT' | 'SUSPEND';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ActiveDto {
  @IsBoolean() active: boolean;
}

export class StatusQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(30) status?: string;
  @IsOptional() @IsUUID() userId?: string;
}

export class LedgerAdminQuery extends PageQuery {
  @IsOptional() @IsIn(LEDGER_STATUSES) status?: LedgerStatus;
  @IsOptional() @IsIn(['COMMISSION', 'MATCHING']) kind?: string;
  @IsOptional() @IsUUID() userId?: string;
}

export class CancelDto {
  @IsBoolean() refund: boolean;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

export class IdsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) ids: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PayoutBatchDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) userIds?: string[];
}

export class DocumentUploadDto {
  @IsUUID() userId: string;
  @IsOptional() @IsUUID() bookingId?: string;
  @IsIn(['AGREEMENT', 'RECEIPT', 'ALLOTMENT', 'OTHER']) type: string;
  @IsString() @IsNotEmpty() @MaxLength(200) title: string;
}

export class DocumentStatusDto {
  @IsIn(['PENDING', 'SENT', 'SIGNED', 'REJECTED', 'EXPIRED']) status: string;
}

export class BroadcastDto {
  @IsIn(['ALL', 'PARTNERS']) audience: 'ALL' | 'PARTNERS';
  @IsString() @IsNotEmpty() @MaxLength(100) title: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) body: string;
}

export class ConfigDto {
  @IsString() @MaxLength(200) value: string;
}

export class AuditQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(50) entity?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
}

export class JobQuery extends PageQuery {
  @IsOptional() @Type(() => Boolean) @IsBoolean() dead?: boolean;
}

const CONFIG_RULES: Record<string, (v: string) => boolean> = {
  hold_minutes: (v) => /^\d+$/.test(v) && +v >= 5 && +v <= 60,
  cooling_days: (v) => /^\d+$/.test(v) && +v <= 90,
  bookings_enabled: (v) => v === 'true' || v === 'false',
  min_app_version: (v) => /^\d+\.\d+\.\d+$/.test(v),
  min_payout_paise: (v) => /^\d+$/.test(v),
  admin_bps: (v) => /^\d+$/.test(v) && +v <= 10000,
  tds_bps: (v) => /^\d+$/.test(v) && +v <= 10000,
  matching_power_pct: (v) => /^\d+$/.test(v) && +v > 0 && +v < 100,
  matching_weak_pct: (v) => /^\d+$/.test(v) && +v > 0 && +v < 100,
  matching_bonus_bps: (v) => /^\d+$/.test(v) && +v <= 10000,
  support_phone: () => true,
  support_email: () => true,
  project_location: (v) => v.length <= 200,
  default_road_width: (v) => v.length <= 50,
  default_plot_image_url: (v) => /^https:\/\//.test(v),
  popular_tier_code: (v) => /^[A-Z0-9_]{1,20}$/.test(v),
  payout_schedule: (v) => v.length <= 100,
};

// ---------- Controller ----------

@Roles('ADMIN')
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
    private readonly settings: Settings,
    private readonly plots: PlotsService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly bookings: BookingService,
    private readonly ledger: LedgerService,
    private readonly payouts: PayoutService,
    private readonly storage: Storage,
    private readonly notify: NotificationService,
  ) {}

  private async page(sqlFrom: string, select: string, order: string, params: unknown[], q: PageQuery) {
    const n = params.length;
    const items = await this.db.many(`select ${select} ${sqlFrom} order by ${order} limit $${n + 1} offset $${n + 2}`, [...params, q.size, q.page * q.size]);
    const { total } = await this.db.one<{ total: number }>(`select count(*) as total ${sqlFrom}`, params);
    return { items, page: q.page, size: q.size, total };
  }

  @Get('dashboard')
  async dashboard() {
    const [plots, bookings, partners, ledger, payouts] = await Promise.all([
      this.db.many(`select status, count(*) as count from plot group by status`),
      this.db.many(
        `select t.name as tier, count(*) as count, sum(b.amount_paise) as amount_paise
         from booking b join tier t on t.id = b.tier_id where b.status = 'CONFIRMED' group by t.name, t.sort order by t.sort`,
      ),
      this.db.one(`select count(*) filter (where partner_status = 'PENDING') as pending, count(*) filter (where partner_status = 'APPROVED') as approved from app_user`),
      this.db.many(`select status, count(*) as count, sum(net_paise) as net_paise from ledger_view group by status`),
      this.db.many(`select status, count(*) as count, sum(amount_paise) as amount_paise from payout group by status`),
    ]);
    return { plots, bookings, partners, ledger, payouts };
  }

  // ----- plots & tiers -----

  @Get('plots')
  listPlots(@Query() q: PlotQuery) {
    return this.plots.list(q);
  }

  @Post('plots')
  async createPlot(@CurrentUser() u: AuthUser, @Body() d: PlotDto) {
    return this.db.tx(async (c) => {
      const p = await this.db.one<{ id: string }>(
        `insert into plot (plot_no, block, facing, area_sqft, price_paise, lat, lng) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [d.plotNo, d.block ?? null, d.facing ?? null, d.areaSqft ?? null, d.pricePaise, d.lat ?? null, d.lng ?? null],
        c,
      );
      await this.audit.log(c, u.id, 'PLOT_CREATE', 'plot', p.id, null, p);
      return p;
    });
  }

  @Put('plots/:id')
  async updatePlot(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: PlotUpdateDto) {
    return this.db.tx(async (c) => {
      const before = await this.db.maybe<{ status: string }>('select * from plot where id = $1 for update', [id], c);
      if (!before) throw notFound('Plot');
      if (d.status && !['AVAILABLE', 'BLOCKED'].includes(before.status)) throw conflict('PLOT_LOCKED', `Plot is ${before.status}; status cannot be changed`);
      const after = await this.db.one(
        `update plot set plot_no = $2, block = $3, facing = $4, area_sqft = $5, price_paise = $6, lat = $7, lng = $8,
                status = coalesce($9, status), updated_at = now() where id = $1 returning *`,
        [id, d.plotNo, d.block ?? null, d.facing ?? null, d.areaSqft ?? null, d.pricePaise, d.lat ?? null, d.lng ?? null, d.status ?? null],
        c,
      );
      await this.audit.log(c, u.id, 'PLOT_UPDATE', 'plot', id, before, after);
      return after;
    });
  }

  /** CSV: plot_no,block,facing,area_sqft,price_paise,lat,lng (header row required). Upserts by plot_no; never touches status. */
  @Post('plots/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async importPlots(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw badRequest('FILE_REQUIRED', 'CSV file is required');
    const lines = file.buffer.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const header = lines.shift()?.toLowerCase().replace(/\s/g, '');
    if (header !== 'plot_no,block,facing,area_sqft,price_paise,lat,lng') throw badRequest('BAD_CSV', 'Header must be plot_no,block,facing,area_sqft,price_paise,lat,lng');
    const num = (v: string) => (v === '' ? null : Number(v));
    const rows = lines.map((l, i) => {
      const [plotNo, block, facing, area, price, lat, lng] = l.split(',').map((s) => s.trim());
      if (!plotNo || !/^\d+$/.test(price)) throw badRequest('BAD_CSV', `Row ${i + 2} is invalid`);
      return [plotNo, block || null, facing || null, num(area), Number(price), num(lat), num(lng)];
    });
    return this.db.tx(async (c) => {
      for (const r of rows) {
        await c.query(
          `insert into plot (plot_no, block, facing, area_sqft, price_paise, lat, lng) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (plot_no) do update set block = excluded.block, facing = excluded.facing, area_sqft = excluded.area_sqft,
             price_paise = excluded.price_paise, lat = excluded.lat, lng = excluded.lng, updated_at = now()`,
          r,
        );
      }
      await this.audit.log(c, u.id, 'PLOT_IMPORT', 'plot', null, null, { rows: rows.length });
      return { imported: rows.length };
    });
  }

  @Get('tiers')
  tiers() {
    return this.plots.tiers(true);
  }

  @Post('tiers')
  createTier(@CurrentUser() u: AuthUser, @Body() d: TierDto) {
    return this.db.tx(async (c) => {
      const t = await this.db.one<{ id: string }>(
        `insert into tier (code, name, amount_paise, l1_bps, l2_bps, l3_bps, benefits, active, sort) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [d.code.toUpperCase(), d.name, d.amountPaise, d.l1Bps, d.l2Bps, d.l3Bps, d.benefits ?? null, d.active, d.sort],
        c,
      );
      await this.audit.log(c, u.id, 'TIER_CREATE', 'tier', t.id, null, t);
      return t;
    });
  }

  /** Existing bookings keep their snapshot of amount and percentages (FR-3.4). */
  @Put('tiers/:id')
  updateTier(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: TierDto) {
    return this.db.tx(async (c) => {
      const before = await this.db.maybe('select * from tier where id = $1 for update', [id], c);
      if (!before) throw notFound('Plan');
      const after = await this.db.one(
        `update tier set code = $2, name = $3, amount_paise = $4, l1_bps = $5, l2_bps = $6, l3_bps = $7, benefits = $8, active = $9, sort = $10
         where id = $1 returning *`,
        [id, d.code.toUpperCase(), d.name, d.amountPaise, d.l1Bps, d.l2Bps, d.l3Bps, d.benefits ?? null, d.active, d.sort],
        c,
      );
      await this.audit.log(c, u.id, 'TIER_UPDATE', 'tier', id, before, after);
      return after;
    });
  }

  // ----- users & partners -----

  @Get('users')
  listUsers(@Query() q: UserQuery) {
    return this.page(
      `from app_user where ($1::text is null or name ilike '%' || $1 || '%' or mobile like '%' || $1 || '%' or email ilike '%' || $1 || '%' or referral_code = upper($1))
         and ($2::text is null or role = $2) and ($3::text is null or partner_status = $3)`,
      'id, role, mobile, email, name, partner_status, referral_code, sponsor_id, leg, active, created_at',
      'created_at desc',
      [q.search ?? null, q.role ?? null, q.partnerStatus ?? null],
      q,
    );
  }

  @Get('users/:id')
  async getUser(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.users.get(id);
    const [bookings, ledger, beneficiary] = await Promise.all([
      this.db.many(`${BOOKING_VIEW} where b.user_id = $1 order by b.created_at desc`, [id]),
      this.db.many(`select kind, status, count(*) as count, sum(net_paise) as net_paise from ledger_view where user_id = $1 group by kind, status`, [id]),
      this.payouts.getBeneficiary(id),
    ]);
    return { user, bookings, ledger, beneficiary };
  }

  @Post('users/:id/partner')
  async partnerAction(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: PartnerActionDto) {
    const r = await this.db.tx((c) => this.users.partnerAction(c, u.id, id, d.action, d.note));
    if (r.partnerStatus === 'APPROVED') await this.payouts.registerFromApplication(id);
    return r;
  }

  @Post('users/:id/active')
  async setActive(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ActiveDto) {
    if (id === u.id) throw badRequest('SELF', 'You cannot deactivate yourself');
    await this.db.tx(async (c) => {
      const n = await this.db.exec('update app_user set active = $2, updated_at = now() where id = $1', [id, d.active], c);
      if (!n) throw notFound('User');
      if (!d.active) await this.tokens.revokeAll(id, c);
      await this.audit.log(c, u.id, d.active ? 'USER_ACTIVATE' : 'USER_DEACTIVATE', 'user', id);
    });
    return { active: d.active };
  }

  // ----- bookings & payments -----

  @Get('bookings')
  listBookings(@Query() q: StatusQuery) {
    return this.page(
      `from booking b join plot p on p.id = b.plot_id join tier t on t.id = b.tier_id join app_user u on u.id = b.user_id
       where ($1::text is null or b.status = $1) and ($2::uuid is null or b.user_id = $2)`,
      'b.id, b.internal_ref, b.status, b.amount_paise, b.created_at, b.confirmed_at, p.plot_no, t.name as tier_name, u.name as customer_name, u.mobile',
      'b.created_at desc',
      [q.status ?? null, q.userId ?? null],
      q,
    );
  }

  @Get('bookings/:id')
  async getBooking(@Param('id', ParseUUIDPipe) id: string) {
    const b = await this.db.maybe(`${BOOKING_VIEW} where b.id = $1`, [id]);
    if (!b) throw notFound('Booking');
    const [payments, commissions] = await Promise.all([
      this.db.many('select * from payment where booking_id = $1 order by created_at', [id]),
      this.db.many('select v.*, u.name as beneficiary_name from ledger_view v join app_user u on u.id = v.user_id where source_booking_id = $1 order by created_at', [id]),
    ]);
    return { ...b, payments, commissions };
  }

  @Post('bookings/:id/cancel')
  cancelBooking(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDto) {
    return this.db.tx(async (c) => {
      const b = await this.bookings.cancel(c, id, u.id, d.refund);
      await this.audit.log(c, u.id, 'BOOKING_CANCEL', 'booking', id, { status: b.status }, { refund: d.refund, reason: d.reason });
      return { ok: true };
    });
  }

  @Get('payments')
  listPayments(@Query() q: StatusQuery) {
    return this.page(
      `from payment p join app_user u on u.id = p.user_id join booking b on b.id = p.booking_id
       where ($1::text is null or p.status = $1) and ($2::uuid is null or p.user_id = $2)`,
      'p.*, u.name as customer_name, b.internal_ref as booking_ref',
      'p.created_at desc',
      [q.status ?? null, q.userId ?? null],
      q,
    );
  }

  // ----- commission ledger -----

  @Get('commissions')
  listLedger(@Query() q: LedgerAdminQuery) {
    return this.page(
      `from ledger_view v join app_user u on u.id = v.user_id left join booking b on b.id = v.source_booking_id
       where ($1::text is null or v.status = $1) and ($2::text is null or v.kind = $2) and ($3::uuid is null or v.user_id = $3)`,
      'v.*, u.name as beneficiary_name, b.internal_ref as booking_ref',
      'v.created_at desc',
      [q.status ?? null, q.kind ?? null, q.userId ?? null],
      q,
    );
  }

  private move(actorId: string, d: IdsDto, from: LedgerStatus[], to: LedgerStatus, action: string) {
    return this.db.tx(async (c) => {
      const changed = await this.ledger.transition(c, d.ids, from, to, actorId, d.note ?? null);
      await this.audit.log(c, actorId, action, 'ledger_entry', null, { ids: d.ids, from }, { to, changed });
      return { requested: d.ids.length, changed };
    });
  }

  @Post('commissions/approve')
  approve(@CurrentUser() u: AuthUser, @Body() d: IdsDto) {
    return this.move(u.id, d, ['ELIGIBLE'], 'APPROVED', 'LEDGER_APPROVE');
  }

  @Post('commissions/hold')
  hold(@CurrentUser() u: AuthUser, @Body() d: IdsDto) {
    return this.move(u.id, d, ['PENDING', 'ELIGIBLE', 'APPROVED'], 'ON_HOLD', 'LEDGER_HOLD');
  }

  @Post('commissions/release')
  release(@CurrentUser() u: AuthUser, @Body() d: IdsDto) {
    return this.move(u.id, d, ['ON_HOLD'], 'ELIGIBLE', 'LEDGER_RELEASE');
  }

  // ----- payouts -----

  @Get('payouts')
  listPayouts(@Query() q: StatusQuery) {
    return this.page(
      `from payout p join app_user u on u.id = p.user_id where ($1::text is null or p.status = $1) and ($2::uuid is null or p.user_id = $2)`,
      'p.*, u.name as partner_name',
      'p.created_at desc',
      [q.status ?? null, q.userId ?? null],
      q,
    );
  }

  @Post('payouts')
  async createPayouts(@CurrentUser() u: AuthUser, @Body() d: PayoutBatchDto) {
    const r = await this.payouts.createBatch(u.id, d.userIds);
    await this.audit.log(this.db.pool, u.id, 'PAYOUT_BATCH', 'payout', null, null, r);
    return r;
  }

  // ----- documents -----

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadDocument(@CurrentUser() u: AuthUser, @Body() d: DocumentUploadDto, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw badRequest('FILE_REQUIRED', 'File is required');
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype)) throw badRequest('FILE_TYPE', 'Only PDF, JPEG or PNG');
    await this.users.get(d.userId);
    if (d.bookingId) {
      const b = await this.db.maybe('select 1 from booking where id = $1 and user_id = $2', [d.bookingId, d.userId]);
      if (!b) throw badRequest('BOOKING_MISMATCH', 'Booking does not belong to this user');
    }
    const key = `documents/${d.userId}/${randomUUID()}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    return this.db.tx(async (c) => {
      const doc = await this.db.one<{ id: string }>(
        `insert into document (user_id, booking_id, type, title, status, storage_key) values ($1, $2, $3, $4, 'SENT', $5)
         returning id, user_id, booking_id, type, title, status, created_at`,
        [d.userId, d.bookingId ?? null, d.type, d.title, key],
        c,
      );
      await this.audit.log(c, u.id, 'DOCUMENT_UPLOAD', 'document', doc.id, null, { ...d });
      await this.notify.notify(c, d.userId, 'DOCUMENT', 'New document', `${d.title} is available`, `document/${doc.id}`);
      return doc;
    });
  }

  @Patch('documents/:id/status')
  documentStatus(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: DocumentStatusDto) {
    return this.db.tx(async (c) => {
      const before = await this.db.maybe<{ status: string; userId: string; title: string }>('select status, user_id, title from document where id = $1 for update', [id], c);
      if (!before) throw notFound('Document');
      await c.query('update document set status = $2, updated_at = now() where id = $1', [id, d.status]);
      await this.audit.log(c, u.id, 'DOCUMENT_STATUS', 'document', id, { status: before.status }, { status: d.status });
      await this.notify.notify(c, before.userId, 'DOCUMENT', 'Document updated', `${before.title}: ${d.status.toLowerCase()}`, `document/${id}`);
      return { status: d.status };
    });
  }

  // ----- notifications, config, audit, jobs -----

  @Post('notifications/broadcast')
  broadcast(@CurrentUser() u: AuthUser, @Body() d: BroadcastDto) {
    return this.db.tx(async (c) => {
      const sent = await this.notify.broadcast(c, d.audience, d.title, d.body);
      await this.audit.log(c, u.id, 'BROADCAST', 'notification', null, null, { ...d, sent });
      return { sent };
    });
  }

  @Get('config')
  config() {
    return this.settings.all();
  }

  @Put('config/:key')
  setConfig(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() d: ConfigDto) {
    const rule = CONFIG_RULES[key];
    if (!rule) throw notFound('Config key');
    if (!rule(d.value)) throw badRequest('INVALID_VALUE', `Invalid value for ${key}`);
    return this.db.tx(async (c) => {
      const before = await this.db.maybe<{ value: string }>('select value from app_config where key = $1 for update', [key], c);
      await c.query('insert into app_config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, d.value]);
      await this.audit.log(c, u.id, 'CONFIG_SET', 'app_config', key, before, { value: d.value });
      return { key, value: d.value };
    });
  }

  @Get('audit')
  auditLog(@Query() q: AuditQuery) {
    return this.page(
      `from audit_log a left join app_user u on u.id = a.actor_id where ($1::text is null or a.entity = $1) and ($2::text is null or a.entity_id = $2)`,
      'a.*, u.name as actor_name',
      'a.id desc',
      [q.entity ?? null, q.entityId ?? null],
      q,
    );
  }

  @Get('jobs')
  jobs(@Query() q: JobQuery) {
    return this.page(`from job where ($1::boolean is null or dead = $1)`, '*', 'id desc', [q.dead ?? null], q);
  }

  @Post('jobs/:id/retry')
  async retryJob(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const n = await this.db.exec(`update job set dead = false, done_at = null, attempts = 0, run_at = now() where id = $1 and dead`, [id]);
    if (!n) throw notFound('Dead job');
    await this.audit.log(this.db.pool, u.id, 'JOB_RETRY', 'job', String(id));
    return { ok: true };
  }
}
