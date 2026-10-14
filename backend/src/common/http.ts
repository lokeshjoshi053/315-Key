import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export class ApiException extends HttpException {
  constructor(status: number, readonly code: string, message: string) {
    super({ code, message }, status);
  }
}

export const notFound = (what: string) => new ApiException(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string) => new ApiException(409, code, msg);
export const badRequest = (code: string, msg: string) => new ApiException(400, code, msg);
export const forbidden = (code = 'FORBIDDEN', msg = 'Not allowed') => new ApiException(403, code, msg);
export const unauthorized = (code = 'UNAUTHORIZED', msg = 'Unauthorized') => new ApiException(401, code, msg);
export const tooMany = (code: string, msg: string) => new ApiException(429, code, msg);
export const providerError = (msg: string) => new ApiException(502, 'PROVIDER_ERROR', msg);
export const unavailable = (code: string, msg: string) => new ApiException(503, code, msg);

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) page = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) size = 20;
}

export const maskMobile = (m?: string | null) => (m && m.length > 4 ? '******' + m.slice(-4) : m ?? null);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('http');

  catch(e: any, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL';
    let message = 'Something went wrong';

    if (e instanceof ApiException) {
      status = e.getStatus();
      code = e.code;
      message = e.message;
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse() as any;
      message = typeof r === 'string' ? r : Array.isArray(r?.message) ? r.message.join('; ') : r?.message ?? e.message;
      code = status === 400 ? 'VALIDATION_FAILED' : status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`;
    } else if (e?.code === '23505') {
      // unique violation: a concurrent request won
      status = 409;
      code = 'CONFLICT';
      message = 'Already exists or state changed, refresh and retry';
    } else {
      this.log.error(`[${req.id}] ${req.method} ${req.url}`, e?.stack ?? e);
    }
    res.status(status).json({ code, message, requestId: req.id });
  }
}

export function requestId(req: Request & { id?: string }, res: Response, next: NextFunction) {
  const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
