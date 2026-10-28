import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from '@yumi/database';
import type { createDatabase } from '@yumi/database';
import type { ApplicationConfig } from './config.js';
import { failure, header } from './http.js';
import type { ApiRequest } from './http.js';

export const STAFF_COOKIE = 'yumi_staff_session';
export const rolePermissions: Record<string, readonly string[]> = {
  SUPER_ADMIN: [
    'staff.read',
    'warehouse.read',
    'catalog.read',
    'catalog.write',
    'stock.read',
    'receipt.read',
    'receipt.write',
    'receipt.approve',
    'receipt.post',
    'location.write',
    'stock.transfer',
    'stock.check',
    'stock.release-hold',
    'count.write',
    'count.approve',
    'count.post',
    'stock.isolate',
    'disposition.write',
    'disposition.approve',
    'disposition.post',
  ],
  OPERATIONS: ['warehouse.read', 'catalog.read', 'catalog.write'],
  WAREHOUSE_MANAGER: [
    'warehouse.read',
    'catalog.read',
    'stock.read',
    'receipt.read',
    'receipt.write',
    'receipt.approve',
    'receipt.post',
    'location.write',
    'stock.transfer',
    'stock.check',
    'stock.release-hold',
    'count.write',
    'count.approve',
    'count.post',
    'stock.isolate',
    'disposition.write',
    'disposition.approve',
    'disposition.post',
  ],
  PICKER: ['warehouse.read', 'catalog.read', 'stock.read'],
  DISPATCHER: ['warehouse.read'],
  RIDER: ['rider.tasks.self'],
  CUSTOMER_SERVICE: [],
};
export interface StaffContext {
  sessionId: string;
  staffId: string;
  loginName: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  warehouseIds: string[];
  csrfToken: string;
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const csrfFor = (token: string) =>
  createHmac('sha256', token).update('yumi-staff-csrf-v1').digest('base64url');

export class StaffAuthService {
  private readonly dummyHash = hashPassword(randomBytes(24).toString('hex'));
  constructor(
    readonly db: ReturnType<typeof createDatabase>,
    readonly config: ApplicationConfig,
  ) {}

  assertOrigin(request: ApiRequest): void {
    const origin = header(request, 'origin');
    if (!origin || !this.config.staffOrigins.includes(origin))
      throw failure(403, 'ORIGIN_REJECTED', '请求来源未获允许');
  }

  async rateLimit(request: ApiRequest, loginName: string): Promise<void> {
    const ip = request.socket.remoteAddress ?? 'unknown';
    const limits = [
      [tokenHash(`ip:${ip}`), 100],
      [tokenHash(`login:${loginName}:${ip}`), 10],
    ] as const;
    for (const [key, max] of limits) {
      const rows = await this.db.$queryRaw<Array<{ attempt_count: number }>>`
        INSERT INTO staff_login_throttles(key,attempt_count,window_started_at)
        VALUES(${key},1,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          attempt_count=CASE WHEN staff_login_throttles.window_started_at < CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN 1 ELSE staff_login_throttles.attempt_count+1 END,
          window_started_at=CASE WHEN staff_login_throttles.window_started_at < CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN CURRENT_TIMESTAMP ELSE staff_login_throttles.window_started_at END
        RETURNING attempt_count`;
      if ((rows[0]?.attempt_count ?? max + 1) > max)
        throw failure(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试');
    }
  }

  async login(request: ApiRequest, loginName: string, password: string) {
    this.assertOrigin(request);
    await this.rateLimit(request, loginName);
    const staff = await this.db.staff.findUnique({ where: { loginName } });
    const valid = await verifyPassword(password, staff?.passwordHash ?? (await this.dummyHash));
    if (!staff?.enabled || !valid) {
      await this.db.authAuditEvent.create({
        data: {
          id: randomUUID(),
          actorId: staff?.id,
          action: 'STAFF_LOGIN',
          outcome: 'DENIED',
          requestId: request.requestId,
        },
      });
      throw failure(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
    }
    const token = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.staffSessionSeconds * 1000);
    await this.db.$transaction(async (tx) => {
      // Re-read enabled/authVersion under a lock so disabling cannot race a new session.
      const current = await tx.$queryRaw<
        Array<{ enabled: boolean; auth_version: number }>
      >`SELECT enabled,auth_version FROM staff WHERE id=${staff.id}::uuid FOR UPDATE`;
      if (!current[0]?.enabled || current[0].auth_version !== staff.authVersion)
        throw failure(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
      await tx.staffSession.create({
        data: {
          id: sessionId,
          staffId: staff.id,
          tokenHash: tokenHash(token),
          authVersion: staff.authVersion,
          expiresAt,
        },
      });
      await tx.authAuditEvent.create({
        data: {
          id: randomUUID(),
          actorId: staff.id,
          action: 'STAFF_LOGIN',
          outcome: 'SUCCEEDED',
          requestId: request.requestId,
        },
      });
    });
    return { token, expiresAt };
  }

  async authenticate(request: ApiRequest): Promise<StaffContext> {
    const cookie = header(request, 'cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${STAFF_COOKIE}=`));
    const token = cookie?.slice(STAFF_COOKIE.length + 1) ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw failure(401, 'AUTH_REQUIRED', '请先登录');
    const session = await this.db.staffSession.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: {
        staff: { include: { roles: true, warehouses: { include: { warehouse: true } } } },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.staff.enabled ||
      session.authVersion !== session.staff.authVersion
    )
      throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    const roles = session.staff.roles.map((role) => role.roleCode);
    return {
      sessionId: session.id,
      staffId: session.staffId,
      loginName: session.staff.loginName,
      displayName: session.staff.displayName,
      roles,
      permissions: [...new Set(roles.flatMap((role) => rolePermissions[role] ?? []))],
      warehouseIds: session.staff.warehouses
        .filter((scope) => scope.warehouse.enabled)
        .map((scope) => scope.warehouseId),
      csrfToken: csrfFor(token),
    };
  }

  assertCsrf(request: ApiRequest, context: StaffContext): void {
    this.assertOrigin(request);
    const token = header(request, 'x-csrf-token') ?? '';
    const expected = Buffer.from(context.csrfToken);
    const received = Buffer.from(token);
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      throw failure(403, 'CSRF_REJECTED', '操作验证已失效，请刷新后重试');
  }

  cookie(token: string, clear = false): string {
    return `${STAFF_COOKIE}=${clear ? '' : token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : this.config.staffSessionSeconds}${this.config.environment === 'production' ? '; Secure' : ''}`;
  }

  async logout(request: ApiRequest, context: StaffContext): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.staffSession.updateMany({
        where: { id: context.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.authAuditEvent.create({
        data: {
          id: randomUUID(),
          actorId: context.staffId,
          action: 'STAFF_LOGOUT',
          outcome: 'SUCCEEDED',
          requestId: request.requestId,
        },
      });
    });
  }
}
