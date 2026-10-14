import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { forbidden, unauthorized } from './http';

export type Role = 'USER' | 'ADMIN';
export interface AuthUser {
  id: string;
  role: Role;
}

export const Public = () => SetMetadata('isPublic', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/** Global guard: everything needs a valid access token unless @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('isPublic', targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let payload: { sub: string; role: Role };
    try {
      payload = this.jwt.verify(header.slice(7), { algorithms: ['HS256'], issuer: 'plots315' });
    } catch {
      throw unauthorized('TOKEN_INVALID', 'Session expired, please sign in again');
    }
    req.user = { id: payload.sub, role: payload.role } satisfies AuthUser;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>('roles', targets);
    if (roles && !roles.includes(payload.role)) throw forbidden();
    return true;
  }
}
