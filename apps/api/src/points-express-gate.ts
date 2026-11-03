import type { Prisma } from '@yumi/database';
import type { ApplicationConfig } from './config.js';
import { failure } from './http.js';
export { validatePointsExpressRuntime } from './points-express-config.js';
export type ExecutionMode = 'DEVELOPMENT' | 'CONTROLLED' | 'PRODUCTION';
export class PointsExpressGate {
  constructor(readonly config: ApplicationConfig) {}
  mode(): ExecutionMode {
    return this.config.pointsExpress?.mode === 'controlled'
      ? 'CONTROLLED'
      : this.config.pointsExpress?.mode === 'production'
        ? 'PRODUCTION'
        : 'DEVELOPMENT';
  }
  async assertSubmit(tx: Prisma.TransactionClient, userId: string, deliveryMode: string) {
    const mode = this.mode(),
      p = this.config.pointsExpress;
    if (mode === 'DEVELOPMENT') {
      if (!this.config.redemptionDevSubmit)
        throw failure(
          503,
          'REDEMPTION_SUBMISSION_DISABLED',
          '兑换提交尚未开放，仅支持已受理订单查询与取消',
        );
    } else if (!p?.submit)
      throw failure(503, 'EXPRESS_SUBMISSION_PAUSED', '新兑换已暂停，已受理订单仍可查询与处理');
    const user = await tx.consumerUser.findUniqueOrThrow({ where: { id: userId } });
    if (mode === 'DEVELOPMENT') {
      if (user.provider !== 'DEVELOPMENT')
        throw failure(403, 'DEVELOPMENT_IDENTITY_REQUIRED', '开发交易仅支持隔离开发身份');
    } else {
      if (user.provider !== 'WECHAT' || user.wechatAppId !== this.config.wechatAppId)
        throw failure(403, 'WECHAT_IDENTITY_REQUIRED', '请使用本小程序微信账号兑换');
      if (deliveryMode !== 'EXPRESS')
        throw failure(409, 'EXPRESS_ONLY', '当前正式模式仅支持积分商品快递发货');
      if (mode === 'CONTROLLED' && !p!.allowedUsers.includes(userId.toLowerCase()))
        throw failure(403, 'CONTROLLED_ACCOUNT_REQUIRED', '当前仅向受控测试账号开放兑换');
    }
    return mode;
  }
  canOperate(mode: string, devEnabled: boolean) {
    return mode === 'DEVELOPMENT'
      ? this.mode() === 'DEVELOPMENT' && devEnabled
      : this.mode() === mode && !!this.config.pointsExpress?.operations;
  }
  assertOperate(mode: string, devEnabled: boolean) {
    if (!this.canOperate(mode, devEnabled))
      throw failure(
        503,
        'EXPRESS_OPERATIONS_PAUSED',
        '本单所属模式的快递作业已暂停或与当前环境不匹配',
      );
  }
}
