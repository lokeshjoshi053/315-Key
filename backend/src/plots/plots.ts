import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Injectable, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Db } from '../db';
import { notFound, PageQuery } from '../common/http';

export interface PlotView {
  id: string;
  plotNo: string;
  block: string | null;
  facing: string | null;
  areaSqft: number | null;
  pricePaise: number;
  lat: number | null;
  lng: number | null;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED';
}

export interface TierView {
  id: string;
  code: string;
  name: string;
  amountPaise: number;
  l1Bps: number;
  l2Bps: number;
  l3Bps: number;
  benefits: string | null;
  active: boolean;
}

// A lapsed hold is shown as AVAILABLE even before the expiry job runs.
export const PLOT_COLS = `id, plot_no, block, facing, area_sqft, price_paise, lat, lng,
  case when status = 'HELD' and held_until < now() then 'AVAILABLE' else status end as status`;

export class PlotQuery extends PageQuery {
  @IsOptional() @IsIn(['AVAILABLE', 'HELD', 'BOOKED', 'BLOCKED']) status?: string;
  @IsOptional() @IsString() @MaxLength(50) block?: string;
  @IsOptional() @IsString() @MaxLength(50) facing?: string;
}

@Injectable()
export class PlotsService {
  constructor(private readonly db: Db) {}

  async list(q: PlotQuery) {
    const where = `from (select ${PLOT_COLS} from plot) p
      where ($1::text is null or p.status = $1) and ($2::text is null or p.block = $2) and ($3::text is null or p.facing = $3)`;
    const params = [q.status ?? null, q.block ?? null, q.facing ?? null];
    const items = await this.db.many<PlotView>(`select * ${where} order by plot_no limit $4 offset $5`, [...params, q.size, q.page * q.size]);
    const { total } = await this.db.one<{ total: number }>(`select count(*) as total ${where}`, params);
    const summary = await this.db.many<{ status: string; count: number }>(
      `select status, count(*) as count from (select ${PLOT_COLS} from plot) p group by status`,
    );
    return { items, page: q.page, size: q.size, total, summary };
  }

  async get(id: string) {
    const p = await this.db.maybe<PlotView>(`select ${PLOT_COLS} from plot where id = $1`, [id]);
    if (!p) throw notFound('Plot');
    return p;
  }

  tiers(includeInactive = false) {
    return this.db.many<TierView>(
      `select id, code, name, amount_paise, l1_bps, l2_bps, l3_bps, benefits, active from tier
       where active or $1 order by sort`,
      [includeInactive],
    );
  }
}

@ApiTags('Plots')
@ApiBearerAuth()
@Controller()
export class PlotsController {
  constructor(private readonly plots: PlotsService) {}

  @Get('plots')
  list(@Query() q: PlotQuery) {
    return this.plots.list(q);
  }

  @Get('plots/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.plots.get(id);
  }

  @Get('tiers')
  tiers() {
    return this.plots.tiers();
  }
}
