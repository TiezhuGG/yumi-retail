import { randomUUID } from 'node:crypto';
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { StaffContext } from './staff-auth.js';
import type { ConsumerContext } from './consumer-auth.js';

export interface ApiRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
  requestId: string;
  staffContext?: StaffContext;
  consumerContext?: ConsumerContext;
  route?: { path?: string };
}
export interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
  on(event: 'finish', callback: () => void): void;
}
export function header(request: ApiRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
export function failure(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}
export function success<const T>(request: ApiRequest, data: T) {
  return { data, requestId: request.requestId };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ApiResponse>();
    const request = host.switchToHttp().getRequest<ApiRequest>();
    const parserType =
      exception instanceof Error && 'type' in exception ? exception.type : undefined;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserType === 'entity.too.large'
          ? 413
          : parserType === 'entity.parse.failed'
            ? 400
            : 500;
    const raw =
      exception instanceof HttpException
        ? exception.getResponse()
        : parserType === 'entity.too.large'
          ? { code: 'PAYLOAD_TOO_LARGE', message: '请求内容超出大小限制' }
          : undefined;
    const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const code =
      typeof payload.code === 'string'
        ? payload.code
        : ((
            {
              400: 'VALIDATION_ERROR',
              401: 'AUTH_REQUIRED',
              403: 'FORBIDDEN',
              404: 'RESOURCE_NOT_FOUND',
              413: 'PAYLOAD_TOO_LARGE',
              429: 'RATE_LIMITED',
            } as Record<number, string>
          )[status] ?? 'INTERNAL_ERROR');
    const message =
      status >= 500
        ? '服务暂时不可用'
        : typeof payload.code === 'string' && typeof payload.message === 'string'
          ? payload.message
          : '请求数据或操作不符合要求';
    response
      .status(status)
      .json({ error: { code, message }, requestId: request.requestId ?? randomUUID() });
  }
}
