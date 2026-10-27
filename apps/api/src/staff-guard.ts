import { SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { StaffAuthService } from './staff-auth.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';

export const Public = () => SetMetadata('public', true);
export const Permissions = (...permissions: string[]) => SetMetadata('permissions', permissions);
export class StaffGuard implements CanActivate {
  private readonly reflector = new Reflector();
  constructor(private readonly auth: StaffAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const staff = await this.auth.authenticate(request);
    request.staffContext = staff;
    const permissions =
      this.reflector.getAllAndOverride<string[]>('permissions', [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (!permissions.every((permission) => staff.permissions.includes(permission))) {
      await this.auth.db.authAuditEvent.create({
        data: {
          id: randomUUID(),
          actorId: staff.staffId,
          action: 'PERMISSION_CHECK',
          outcome: 'DENIED',
          requestId: request.requestId,
        },
      });
      throw failure(403, 'FORBIDDEN', '该账号无权执行此操作');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) this.auth.assertCsrf(request, staff);
    return true;
  }
}
