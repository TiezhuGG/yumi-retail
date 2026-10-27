import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { StaffAuthService } from './staff-auth.js';
import { Public, Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest, ApiResponse } from './http.js';
import {
  ApiResult,
  object,
  text,
  items,
  warehouseSchema,
  staffProfileSchema,
} from './api-result.js';

class StaffLoginInput {
  @ApiProperty({ minLength: 3, maxLength: 64, example: 'admin.local' }) loginName!: string;
  @ApiProperty({ format: 'password', maxLength: 128 }) password!: string;
}
@ApiTags('员工认证')
@Controller('staff')
export class StaffController {
  constructor(@Inject(StaffAuthService) private readonly auth: StaffAuthService) {}
  @Public()
  @Post('auth/session')
  @HttpCode(200)
  @ApiOperation({ summary: '员工登录；设置HttpOnly会话Cookie' })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiBody({ type: StaffLoginInput })
  @ApiResult(
    object({ expiresAt: { type: 'string', format: 'date-time' } }),
    [400, 401, 403, 429, 500],
  )
  async login(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw failure(400, 'VALIDATION_ERROR', '请填写账号与密码');
    const fields = body as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !['loginName', 'password'].includes(key)) ||
      typeof fields.loginName !== 'string' ||
      typeof fields.password !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(fields.loginName.trim()) ||
      !fields.password.length ||
      fields.password.length > 128 ||
      Buffer.byteLength(fields.password, 'utf8') > 256
    )
      throw failure(400, 'VALIDATION_ERROR', '账号或密码格式不正确');
    const result = await this.auth.login(
      request,
      fields.loginName.trim().toLowerCase(),
      fields.password,
    );
    response.setHeader('Set-Cookie', this.auth.cookie(result.token));
    return success(request, { expiresAt: result.expiresAt.toISOString() });
  }
  @Get('me')
  @ApiCookieAuth('staffSession')
  @ApiOperation({ summary: '当前员工、权限、仓库范围和CSRF token' })
  @ApiResult(staffProfileSchema)
  me(@Req() request: ApiRequest) {
    const staff = request.staffContext!;
    return success(request, {
      id: staff.staffId,
      loginName: staff.loginName,
      displayName: staff.displayName,
      roles: staff.roles,
      permissions: staff.permissions,
      warehouseIds: staff.warehouseIds,
      csrfToken: staff.csrfToken,
    });
  }
  @Post('auth/logout')
  @HttpCode(200)
  @ApiCookieAuth('staffSession')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiOperation({ summary: '退出并撤销当前会话' })
  @ApiResult(object({ loggedOut: { type: 'boolean' } }))
  async logout(@Req() request: ApiRequest, @Res({ passthrough: true }) response: ApiResponse) {
    await this.auth.logout(request, request.staffContext!);
    response.setHeader('Set-Cookie', this.auth.cookie('', true));
    return success(request, { loggedOut: true });
  }
}

@ApiTags('仓库范围')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses')
export class WarehouseController {
  constructor(@Inject(StaffAuthService) private readonly auth: StaffAuthService) {}
  @Get()
  @Permissions('warehouse.read')
  @ApiOperation({ summary: '只返回授权且启用的仓库' })
  @ApiResult(items(warehouseSchema))
  async list(@Req() request: ApiRequest) {
    const warehouses = await this.auth.db.warehouse.findMany({
      where: { id: { in: request.staffContext!.warehouseIds }, enabled: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
    return success(request, { items: warehouses });
  }
  @Get(':warehouseId')
  @Permissions('warehouse.read')
  @ApiOperation({ summary: '服务端校验仓库范围' })
  @ApiResult(warehouseSchema, [400, 401, 403, 404, 500])
  async detail(@Param('warehouseId') warehouseId: string, @Req() request: ApiRequest) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(warehouseId))
      throw failure(400, 'VALIDATION_ERROR', '仓库编号格式不正确');
    if (!request.staffContext!.warehouseIds.includes(warehouseId))
      throw failure(403, 'FORBIDDEN', '无权访问该仓库');
    const warehouse = await this.auth.db.warehouse.findFirst({
      where: { id: warehouseId, enabled: true },
      select: { id: true, code: true, name: true },
    });
    if (!warehouse) throw failure(404, 'RESOURCE_NOT_FOUND', '仓库不存在或已停用');
    return success(request, warehouse);
  }
}

@ApiTags('员工管理')
@ApiCookieAuth('staffSession')
@Controller('admin/staff')
export class StaffAdminController {
  constructor(@Inject(StaffAuthService) private readonly auth: StaffAuthService) {}
  @Get()
  @Permissions('staff.read')
  @ApiOperation({ summary: '员工最小只读列表，最多100条' })
  @ApiResult(
    items(
      object({
        id: text,
        loginName: text,
        displayName: text,
        enabled: { type: 'boolean' },
        roles: { type: 'array', items: object({ roleCode: text }) },
      }),
    ),
  )
  async list(@Req() request: ApiRequest) {
    const rows = await this.auth.db.staff.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        loginName: true,
        displayName: true,
        enabled: true,
        roles: { select: { roleCode: true } },
      },
    });
    return success(request, { items: rows });
  }
}
