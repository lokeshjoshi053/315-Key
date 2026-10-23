import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Inject, Injectable, Logger, OnApplicationBootstrap, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { randomBytes, randomInt } from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CONFIG, Config } from '../config';
import { Db, Queryable } from '../db';
import { Public, Role } from '../common/auth';
import { ApiException, badRequest, forbidden, providerError, tooMany, unauthorized } from '../common/http';
import { safeEqual, sha256 } from '../common/support';
import { MOBILE_RE, UsersService } from '../users/users';

// ---------- OTP delivery (vendor edge) ----------

export abstract class OtpSender {
  abstract send(mobile: string, code: string): Promise<void>;
}

export class LogOtpSender extends OtpSender {
  private readonly log = new Logger('otp');
  async send(mobile: string, code: string) {
    this.log.warn(`DEV OTP for ${mobile}: ${code}`);
  }
}

/** VERIFY: MSG91 flow API + DLT-registered template with an `otp` variable. */
export class Msg91OtpSender extends OtpSender {
  constructor(private readonly authKey: string, private readonly templateId: string) {
    super();
  }
  async send(mobile: string, code: string) {
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.authKey, 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: this.templateId, short_url: '0', recipients: [{ mobiles: `91${mobile}`, otp: code }] }),
    });
    if (!res.ok) throw providerError('Could not send OTP, try again');
  }
}

// ---------- Tokens ----------

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  async issue(q: Queryable, userId: string, role: Role, deviceId?: string): Promise<Tokens> {
    const accessToken = this.jwt.sign({ sub: userId, role }, { expiresIn: this.cfg.accessTtlSec });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.exec(
      `insert into refresh_token (user_id, token_hash, device_id, expires_at)
       values ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, sha256(refreshToken), deviceId ?? null, this.cfg.refreshTtlDays],
      q,
    );
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSec };
  }

  /** Rotating refresh. Presenting an already-rotated token revokes every session (theft signal). */
  async refresh(raw: string): Promise<Tokens> {
    const r = await this.db.tx(async (c) => {
      const row = await this.db.maybe<{ id: string; userId: string; deviceId: string | null; revokedAt: Date | null; expiresAt: Date; role: Role; active: boolean }>(
        `select rt.id, rt.user_id, rt.device_id, rt.revoked_at, rt.expires_at, u.role, u.active
         from refresh_token rt join app_user u on u.id = rt.user_id where rt.token_hash = $1 for update of rt`,
        [sha256(raw)],
        c,
      );
      if (!row || row.expiresAt < new Date()) return { error: unauthorized('TOKEN_INVALID', 'Session expired') };
      if (row.revokedAt) {
        await this.revokeAll(row.userId, c);
        return { error: unauthorized('TOKEN_REUSED', 'Session revoked, please sign in again') };
      }
      if (!row.active) return { error: forbidden('ACCOUNT_DISABLED', 'Account is disabled') };
      await c.query('update refresh_token set revoked_at = now() where id = $1', [row.id]);
      return { tokens: await this.issue(c, row.userId, row.role, row.deviceId ?? undefined) };
    });
    if ('error' in r) throw r.error;
    return r.tokens!;
  }

  revoke(raw: string) {
    return this.db.exec('update refresh_token set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha256(raw)]);
  }

  revokeAll(userId: string, q?: Queryable) {
    return this.db.exec('update refresh_token set revoked_at = now() where user_id = $1 and revoked_at is null', [userId], q);
  }
}

// ---------- Auth flows ----------

const OTP_TTL_MIN = 5;
const OTP_MAX_SENDS = 3; // per 15 minutes
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly log = new Logger('auth');
  private readonly googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  private readonly firebaseJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

  constructor(
    private readonly db: Db,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly otp: OtpSender,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Seeds/promotes the first admin from BOOTSTRAP_ADMIN_MOBILE (FR-1.5). */
  async onApplicationBootstrap() {
    const m = this.cfg.bootstrapAdminMobile;
    if (!m) return;
    await this.db.exec(
      `insert into app_user (mobile, role, name) values ($1, 'ADMIN', 'Admin')
       on conflict (mobile) do update set role = 'ADMIN'`,
      [m],
    );
    this.log.log(`bootstrap admin ensured for ******${m.slice(-4)}`);
  }

  async requestOtp(mobile: string) {
    const { n } = await this.db.one<{ n: number }>(
      `select count(*) as n from otp_challenge where mobile = $1 and created_at > now() - interval '15 minutes'`,
      [mobile],
    );
    if (n >= OTP_MAX_SENDS) throw tooMany('OTP_RATE_LIMITED', 'Too many OTP requests, try again in 15 minutes');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.exec(
      `insert into otp_challenge (mobile, code_hash, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [mobile, sha256(`${mobile}:${code}`), OTP_TTL_MIN],
    );
    await this.otp.send(mobile, code);
    return { expiresInSec: OTP_TTL_MIN * 60, resendAfterSec: 30 };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    // Errors are returned (not thrown) so the attempts counter still commits.
    const r = await this.db.tx(async (c) => {
      const ch = await this.db.maybe<{ id: string; codeHash: string; expiresAt: Date; attempts: number }>(
        `select id, code_hash, expires_at, attempts from otp_challenge
         where mobile = $1 and consumed_at is null order by created_at desc limit 1 for update`,
        [dto.mobile],
        c,
      );
      if (!ch || ch.expiresAt < new Date()) return { error: badRequest('OTP_EXPIRED', 'OTP expired, request a new one') };
      if (ch.attempts >= OTP_MAX_ATTEMPTS) return { error: tooMany('OTP_LOCKED', 'Too many attempts, request a new OTP') };
      if (!safeEqual(sha256(`${dto.mobile}:${dto.code}`), ch.codeHash)) {
        await c.query('update otp_challenge set attempts = attempts + 1 where id = $1', [ch.id]);
        return { error: badRequest('OTP_INVALID', 'Incorrect OTP') };
      }
      await c.query('update otp_challenge set consumed_at = now() where id = $1', [ch.id]);
      return this.signInMobile(c, dto.mobile, dto);
    });
    if ('error' in r) throw r.error;
    return r.result!;
  }

  /** Firebase Phone Auth: the app verifies the number with Firebase and sends its ID token. */
  async firebasePhone(dto: FirebasePhoneDto) {
    const projectId = this.cfg.firebaseProjectId;
    if (!projectId) throw new ApiException(501, 'NOT_CONFIGURED', 'Firebase phone sign-in is not configured');
    let phone: string | undefined;
    try {
      const { payload } = await jwtVerify(dto.idToken, this.firebaseJwks, { issuer: `https://securetoken.google.com/${projectId}`, audience: projectId });
      phone = payload.phone_number as string | undefined;
    } catch {
      throw unauthorized('FIREBASE_TOKEN_INVALID', 'Phone sign-in failed, try again');
    }
    const mobile = /^\+91([6-9]\d{9})$/.exec(phone ?? '')?.[1];
    if (!mobile) throw badRequest('PHONE_NOT_SUPPORTED', 'Use an Indian mobile number');
    const r = await this.db.tx((c) => this.signInMobile(c, mobile, dto));
    if ('error' in r) throw r.error;
    return r.result!;
  }

  private async signInMobile(c: Queryable, mobile: string, o: { referralCode?: string; leg?: 'L' | 'R'; deviceId?: string }) {
    let user = await this.users.findBy('mobile', mobile, c);
    const isNew = !user;
    if (!user) user = await this.users.create(c, { mobile }, o.referralCode, o.leg);
    if (!user.active) return { error: forbidden('ACCOUNT_DISABLED', 'Account is disabled') };
    return { result: { ...(await this.tokens.issue(c, user.id, user.role, o.deviceId)), isNewUser: isNew, profileComplete: !!user.name } };
  }

  async google(dto: GoogleDto) {
    if (!this.cfg.googleClientIds.length) throw new ApiException(501, 'NOT_CONFIGURED', 'Google sign-in is not configured');
    let claims: { sub: string; email?: string; email_verified?: boolean; name?: string };
    try {
      const { payload } = await jwtVerify(dto.idToken, this.googleJwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.cfg.googleClientIds,
      });
      claims = payload as typeof claims;
    } catch {
      throw unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed');
    }
    if (!claims.email || !claims.email_verified) throw unauthorized('GOOGLE_EMAIL_UNVERIFIED', 'Google email is not verified');
    const email = claims.email.toLowerCase();

    return this.db.tx(async (c) => {
      let user = (await this.users.findBy('google_sub', claims.sub, c)) ?? (await this.users.findBy('email', email, c));
      const isNew = !user;
      if (user && !user.active) throw forbidden('ACCOUNT_DISABLED', 'Account is disabled');
      if (user) {
        await c.query('update app_user set google_sub = $2 where id = $1 and google_sub is null', [user.id, claims.sub]);
      } else {
        user = await this.users.create(c, { email, googleSub: claims.sub, name: claims.name }, dto.referralCode, dto.leg);
      }
      return { ...(await this.tokens.issue(c, user.id, user.role, dto.deviceId)), isNewUser: isNew, profileComplete: !!user.name };
    });
  }
}

// ---------- DTOs + controller ----------

export class RequestOtpDto {
  @Matches(/^[6-9]\d{9}$/, { message: 'mobile must be a valid 10-digit Indian number' }) mobile: string;
}

export class VerifyOtpDto {
  @Matches(/^[6-9]\d{9}$/) mobile: string;
  @Length(6, 6) @Matches(/^\d{6}$/) code: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
  @IsOptional() @IsIn(['L', 'R']) leg?: 'L' | 'R';
  @IsOptional() @IsString() @MaxLength(200) deviceId?: string;
}

export class GoogleDto {
  @IsString() @IsNotEmpty() idToken: string;
  @IsOptional() @IsString() @MaxLength(20) referralCode?: string;
  @IsOptional() @IsIn(['L', 'R']) leg?: 'L' | 'R';
  @IsOptional() @IsString() @MaxLength(200) deviceId?: string;
}

export class FirebasePhoneDto extends GoogleDto {}

export class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

@Public()
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  // Per-IP flood guard only. Indian mobile carriers NAT many users behind one IP, so keep it loose;
  // the real limit is per mobile number in AuthService (3 sends / 15 min, 5 attempts per code).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(200)
  request(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.mobile);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('otp/verify')
  @HttpCode(200)
  verify(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Post('google')
  @HttpCode(200)
  google(@Body() dto: GoogleDto) {
    return this.auth.google(dto);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('firebase')
  @HttpCode(200)
  firebase(@Body() dto: FirebasePhoneDto) {
    return this.auth.firebasePhone(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.tokens.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto) {
    await this.tokens.revoke(dto.refreshToken);
    return { ok: true };
  }
}
