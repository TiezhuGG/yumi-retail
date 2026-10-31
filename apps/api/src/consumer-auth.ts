import { randomBytes, randomUUID } from 'node:crypto';
import type { createDatabase } from '@yumi/database';
import type { ApplicationConfig } from './config.js';
import { failure, header } from './http.js';
import type { ApiRequest } from './http.js';
import { tokenHash } from './staff-auth.js';

export interface ConsumerContext {
  sessionId: string;
  userId: string;
  displayName: string;
  provider: 'DEVELOPMENT';
  expiresAt: string;
}
export function validateConsumerEnvironment(databaseUrl: string, config: ApplicationConfig) {
  if (!config.consumerDevLogin) return;
  const url = new URL(databaseUrl);
  if (
    config.environment === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/yumi_dev', '/yumi_test'].includes(url.pathname)
  )
    throw Error('Development consumer identities require the isolated local database.');
}
export class ConsumerAuthService {
  constructor(
    readonly db: ReturnType<typeof createDatabase>,
    readonly config: ApplicationConfig,
  ) {}

  developmentAllowed(request: ApiRequest) {
    // Never trust proxy-provided addresses for this intentionally local-only adapter.
    const origin = header(request, 'origin');
    return (
      this.config.consumerDevLogin === true &&
      this.config.environment !== 'production' &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
      !Object.keys(request.headers).some(
        (k) => k === 'forwarded' || k.startsWith('x-forwarded-'),
      ) &&
      (!origin || this.config.staffOrigins.includes(origin))
    );
  }
  async login(request: ApiRequest, body: unknown) {
    if (!this.developmentAllowed(request))
      throw failure(404, 'RESOURCE_NOT_FOUND', '开发登录未开放');
    // This non-simple header also prevents drive-by browser form/JSON login.
    if (header(request, 'x-yumi-dev-login') !== '1')
      throw failure(403, 'DEV_LOGIN_REJECTED', '请从本机开发身份入口登录');
    const key = tokenHash(`consumer-dev-ip:${request.socket.remoteAddress}`);
    const rows = await this.db.$queryRaw<Array<{ attempt_count: number }>>`
      INSERT INTO consumer_login_throttles(key,attempt_count,window_started_at)
      VALUES(${key},1,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET
        attempt_count=CASE WHEN consumer_login_throttles.window_started_at < CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN 1 ELSE consumer_login_throttles.attempt_count+1 END,
        window_started_at=CASE WHEN consumer_login_throttles.window_started_at < CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN CURRENT_TIMESTAMP ELSE consumer_login_throttles.window_started_at END
      RETURNING attempt_count`;
    if ((rows[0]?.attempt_count ?? 31) > 30)
      throw failure(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试');
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).join(',') !== 'profile' ||
      !['customer-a', 'customer-b'].includes((body as { profile: string }).profile)
    )
      throw failure(400, 'VALIDATION_ERROR', '请选择预设的开发身份');
    const subject = (body as { profile: string }).profile;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + (this.config.consumerSessionSeconds ?? 28800) * 1000);
    const user = await this.db.$transaction(async (tx) => {
      // The upsert locks the identity, including simultaneous first logins and account disabling.
      const current = await tx.consumerUser.upsert({
        where: { provider_subject: { provider: 'DEVELOPMENT', subject } },
        create: {
          id: randomUUID(),
          provider: 'DEVELOPMENT',
          subject,
          displayName: subject === 'customer-a' ? '开发顾客 A' : '开发顾客 B',
        },
        update: { subject },
      });
      if (!current.enabled) {
        await tx.consumerAuthAudit.create({
          data: {
            id: randomUUID(),
            userId: current.id,
            action: 'DEV_LOGIN',
            outcome: 'DENIED',
            requestId: request.requestId,
          },
        });
        return null;
      }
      await tx.consumerSession.create({
        data: {
          id: randomUUID(),
          userId: current.id,
          authVersion: current.authVersion,
          tokenHash: tokenHash(token),
          expiresAt,
        },
      });
      await tx.consumerAuthAudit.create({
        data: {
          id: randomUUID(),
          userId: current.id,
          action: 'DEV_LOGIN',
          outcome: 'SUCCEEDED',
          requestId: request.requestId,
        },
      });
      return current;
    });
    if (!user) throw failure(401, 'IDENTITY_UNAVAILABLE', '该开发身份暂不可用');
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, displayName: user.displayName, provider: 'DEVELOPMENT' as const },
    };
  }
  async authenticate(request: ApiRequest): Promise<ConsumerContext> {
    const bearer = header(request, 'authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer)) throw failure(401, 'AUTH_REQUIRED', '请先登录');
    const session = await this.db.consumerSession.findUnique({
      where: { tokenHash: tokenHash(bearer.slice(7)) },
      include: { user: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.user.enabled ||
      session.authVersion !== session.user.authVersion ||
      session.user.provider !== 'DEVELOPMENT' ||
      !this.developmentAllowed(request)
    )
      throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    return {
      sessionId: session.id,
      userId: session.userId,
      displayName: session.user.displayName,
      provider: 'DEVELOPMENT',
      expiresAt: session.expiresAt.toISOString(),
    };
  }
  async logout(request: ApiRequest, context: ConsumerContext) {
    await this.db.$transaction(async (tx) => {
      await tx.consumerSession.updateMany({
        where: { id: context.sessionId, userId: context.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.consumerAuthAudit.create({
        data: {
          id: randomUUID(),
          userId: context.userId,
          action: 'LOGOUT',
          outcome: 'SUCCEEDED',
          requestId: request.requestId,
        },
      });
    });
  }
}
