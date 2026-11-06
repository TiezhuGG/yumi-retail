import { randomBytes, randomUUID } from 'node:crypto';
import type { createDatabase } from '@yumi/database';
import type { ApplicationConfig } from './config.js';
import { failure, header } from './http.js';
import type { ApiRequest } from './http.js';
import { wechatExchange, type WechatExchange } from './wechat-login.js';
import { fields, str } from './catalog-input.js';
import { tokenHash } from './staff-auth.js';
import type { Prisma } from '@yumi/database';
import { WechatPayerPrivateData } from './wechat-payer-private.js';

export interface ConsumerContext {
  sessionId: string;
  userId: string;
  displayName: string;
  provider: 'DEVELOPMENT' | 'WECHAT';
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
  private readonly payerStorage: WechatPayerPrivateData;
  constructor(
    readonly db: ReturnType<typeof createDatabase>,
    readonly config: ApplicationConfig,
    readonly exchange: WechatExchange = wechatExchange(config),
  ) {
    this.payerStorage = new WechatPayerPrivateData(config.wechatPayerEncryption);
  }

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
  async wechatLogin(request: ApiRequest, input: unknown) {
    if (!this.config.wechatLogin || !this.config.wechatAppId || !this.config.wechatAppSecret)
      throw failure(404, 'RESOURCE_NOT_FOUND', '微信登录暂未开放');
    const origin = header(request, 'origin');
    if (origin && !this.config.staffOrigins.includes(origin))
      throw failure(403, 'ORIGIN_REJECTED', '登录来源未获允许');
    const b = fields(input, ['code']),
      code = str(b.code, 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(code))
      throw failure(400, 'VALIDATION_ERROR', '微信登录凭证格式无效，请重新登录');
    const throttle = tokenHash('wechat-login-ip:' + (request.socket.remoteAddress ?? 'unknown'));
    const rows = await this.db.$queryRaw<
      Array<{ attempt_count: number }>
    >`INSERT INTO consumer_login_throttles(key,attempt_count,window_started_at) VALUES(${throttle},1,clock_timestamp()) ON CONFLICT(key) DO UPDATE SET attempt_count=CASE WHEN consumer_login_throttles.window_started_at<clock_timestamp()-interval '1 minute' THEN 1 ELSE consumer_login_throttles.attempt_count+1 END,window_started_at=CASE WHEN consumer_login_throttles.window_started_at<clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE consumer_login_throttles.window_started_at END RETURNING attempt_count`;
    if (rows[0]!.attempt_count > 60) throw failure(429, 'RATE_LIMITED', '登录过于频繁，请稍后再试');
    const keyHash = tokenHash(this.config.wechatAppId + ':' + code);
    await this.db
      .$executeRaw`DELETE FROM consumer_wechat_login_codes WHERE key_hash IN (SELECT key_hash FROM consumer_wechat_login_codes WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 100)`;
    // Claim before network I/O, outside issuance transaction. Never replay a token from a login code.
    const claimed = await this.db.$queryRaw<
      Array<{ key_hash: string }>
    >`INSERT INTO consumer_wechat_login_codes(key_hash,expires_at) VALUES(${keyHash},clock_timestamp()+interval '10 minutes') ON CONFLICT(key_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE consumer_wechat_login_codes.expires_at<=clock_timestamp() RETURNING key_hash`;
    if (!claimed.length) throw failure(401, 'WECHAT_CODE_USED', '该微信登录凭证已使用，请重新登录');
    const { openid } = await this.exchange(code);
    if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(openid))
      throw failure(503, 'WECHAT_RESPONSE_INVALID', '微信身份服务返回异常，请重新登录');
    const subject = tokenHash(this.config.wechatAppId + ':' + openid),
      token = randomBytes(32).toString('base64url');
    const result = await this.db.$transaction(async (tx) => {
      const user = await tx.consumerUser.upsert({
        where: { provider_subject: { provider: 'WECHAT', subject } },
        create: {
          id: randomUUID(),
          provider: 'WECHAT',
          subject,
          wechatAppId: this.config.wechatAppId!,
          displayName: '微信顾客',
        },
        update: { subject },
      });
      if (!user.enabled) {
        await tx.consumerAuthAudit.create({
          data: {
            id: randomUUID(),
            userId: user.id,
            action: 'WECHAT_LOGIN',
            outcome: 'DENIED',
            requestId: request.requestId,
          },
        });
        return null;
      }
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
          .now,
        expiresAt = new Date(now.getTime() + (this.config.consumerSessionSeconds ?? 28800) * 1000);
      if (this.payerStorage.configured) {
        const encrypted = this.payerStorage.encrypt(
          { userId: user.id, appId: user.wechatAppId!, subject: user.subject },
          openid,
        );
        await tx.consumerWechatPayer.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            appId: user.wechatAppId!,
            ...encrypted,
            createdAt: now,
            updatedAt: now,
          },
          update: { ...encrypted, version: { increment: 1 }, updatedAt: now },
        });
      }
      await tx.consumerSession.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          authVersion: user.authVersion,
          tokenHash: tokenHash(token),
          createdAt: now,
          expiresAt,
        },
      });
      await tx.consumerAuthAudit.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          action: 'WECHAT_LOGIN',
          outcome: 'SUCCEEDED',
          requestId: request.requestId,
        },
      });
      return {
        token,
        expiresAt: expiresAt.toISOString(),
        user: { id: user.id, displayName: user.displayName, provider: 'WECHAT' as const },
      };
    });
    if (!result) throw failure(401, 'IDENTITY_UNAVAILABLE', '此账号暂不可用');
    return result;
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
      (session.user.provider === 'DEVELOPMENT'
        ? !this.developmentAllowed(request)
        : session.user.provider !== 'WECHAT' ||
          !this.config.wechatLogin ||
          session.user.wechatAppId !== this.config.wechatAppId)
    )
      throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    return {
      sessionId: session.id,
      userId: session.userId,
      displayName: session.user.displayName,
      provider: session.user.provider as 'DEVELOPMENT' | 'WECHAT',
      expiresAt: session.expiresAt.toISOString(),
    };
  }
  // Internal transaction-scoped accessor only. Never expose this return value from an API.
  async paymentPayer(tx: Prisma.TransactionClient, request: ApiRequest, appId: string) {
    const context = request.consumerContext;
    if (!context) throw failure(401, 'AUTH_REQUIRED', '请先登录');
    const rows = await tx.$queryRaw<
      Array<{ id: string; provider: string; app_id: string | null; subject: string }>
    >`
      SELECT u.id,u.provider,u.wechat_app_id AS app_id,u.subject FROM consumer_sessions s
      JOIN consumer_users u ON u.id=s.user_id
      WHERE s.id=${context.sessionId}::uuid AND u.id=${context.userId}::uuid AND u.enabled
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version
      FOR SHARE OF s,u`;
    const user = rows[0];
    if (!user) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    if (
      user.provider !== 'WECHAT' ||
      !this.config.wechatLogin ||
      appId !== this.config.wechatAppId ||
      user.app_id !== appId
    )
      throw failure(403, 'PAYER_IDENTITY_REQUIRED', '请使用当前小程序的微信账号登录');
    if (!this.payerStorage.configured)
      throw failure(503, 'PAYER_STORAGE_UNAVAILABLE', '支付身份加密尚未配置');
    const binding = await tx.consumerWechatPayer.findUnique({ where: { userId: user.id } });
    if (!binding) throw failure(409, 'PAYER_REFRESH_REQUIRED', '支付身份需重新微信登录后核验');
    if (binding.appId !== appId)
      throw failure(503, 'PAYER_IDENTITY_INVALID', '支付身份暂时无法核验');
    const openId = this.payerStorage.decrypt(
      { userId: user.id, appId, subject: user.subject },
      binding,
    );
    const valid = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM consumer_sessions WHERE id=${context.sessionId}::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
    if (!valid.length) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    return { provider: 'WECHAT' as const, appId, openId };
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
  async updateNickname(request: ApiRequest, input: unknown) {
    const b = fields(input, ['displayName', 'expectedDisplayName']);
    if (typeof b.displayName !== 'string') throw failure(400, 'VALIDATION_ERROR', '请填写昵称');
    const displayName = b.displayName.trim().normalize('NFC');
    if (
      !displayName ||
      Array.from(displayName).length > 20 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(displayName) ||
      !/[\p{L}\p{N}\p{P}\p{S}]/u.test(displayName)
    )
      throw failure(400, 'VALIDATION_ERROR', '昵称须为1至20个可见字符，不含换行或隐藏字符');
    if (
      typeof b.expectedDisplayName !== 'string' ||
      !b.expectedDisplayName ||
      Array.from(b.expectedDisplayName).length > 80
    )
      throw failure(400, 'VALIDATION_ERROR', '请重新读取当前昵称后保存');
    const expectedDisplayName = b.expectedDisplayName;
    const context = request.consumerContext!;
    return this.db.$transaction(async (tx) => {
      // Hold the current session before the user row, so concurrent logout and
      // profile changes cannot commit after revocation or overwrite another name.
      const sessions = await tx.$queryRaw<Array<{ expires_at: Date; auth_version: number }>>`
        SELECT expires_at,auth_version FROM consumer_sessions
        WHERE id=${context.sessionId}::uuid AND user_id=${context.userId}::uuid
          AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`;
      const users = await tx.$queryRaw<
        Array<{ display_name: string; provider: string; auth_version: number; enabled: boolean }>
      >`
        SELECT display_name,provider,auth_version,enabled FROM consumer_users
        WHERE id=${context.userId}::uuid FOR NO KEY UPDATE`;
      const s = sessions[0],
        u = users[0];
      if (!s || !u?.enabled || s.auth_version !== u.auth_version)
        throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
      if (u.display_name !== displayName && u.display_name !== expectedDisplayName)
        throw failure(409, 'PROFILE_CHANGED', '昵称已在其他设备修改，请核对最新昵称后保存');
      if (u.display_name !== displayName)
        await tx.consumerUser.update({ where: { id: context.userId }, data: { displayName } });
      const valid = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM consumer_sessions WHERE id=${context.sessionId}::uuid
          AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
      if (!valid.length)
        throw failure(401, 'SESSION_EXPIRED', '登录在保存期间失效，请重新登录后核实');
      return {
        user: { id: context.userId, displayName, provider: u.provider as 'DEVELOPMENT' | 'WECHAT' },
        expiresAt: s.expires_at.toISOString(),
      };
    });
  }
}
