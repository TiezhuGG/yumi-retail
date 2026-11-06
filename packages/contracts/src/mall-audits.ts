export const MALL_AUDIT_GROUPS = {
  REWARDS: '兑换商品',
  POINTS: '积分操作',
  SHIPPING: '快递发货',
  RETURNS: '售后处理',
  CUSTOMERS: '顾客管理',
  EXPORTS: '数据导出',
  SETTINGS: '经营配置',
} as const;
export type MallAuditGroup = keyof typeof MALL_AUDIT_GROUPS;
export const MALL_AUDIT_ACTIONS = {
  REWARD_CREATE: { label: '创建兑换商品', group: 'REWARDS', source: 'REWARD' },
  REWARD_UPDATE: { label: '修改兑换商品', group: 'REWARDS', source: 'REWARD' },
  REWARD_PUBLISH: { label: '上架兑换商品', group: 'REWARDS', source: 'REWARD' },
  REWARD_UNPUBLISH: { label: '下架兑换商品', group: 'REWARDS', source: 'REWARD' },
  POINTS_CREATE: { label: '创建积分发放申请', group: 'POINTS', source: 'GRANT' },
  POINTS_APPROVE: { label: '批准积分发放', group: 'POINTS', source: 'GRANT' },
  POINTS_REJECT: { label: '拒绝积分发放', group: 'POINTS', source: 'GRANT' },
  POINTS_CANCEL: { label: '撤销积分发放申请', group: 'POINTS', source: 'GRANT' },
  POINTS_CORRECTION_CREATE: { label: '创建误发冲正申请', group: 'POINTS', source: 'CORRECTION' },
  POINTS_CORRECTION_APPROVE: { label: '批准误发冲正', group: 'POINTS', source: 'CORRECTION' },
  POINTS_CORRECTION_REJECT: { label: '拒绝误发冲正', group: 'POINTS', source: 'CORRECTION' },
  POINTS_CORRECTION_CANCEL: { label: '撤销误发冲正申请', group: 'POINTS', source: 'CORRECTION' },
  REDEMPTION_EXPRESS_SHIP: { label: '登记订单快递发货', group: 'SHIPPING', source: 'ORDER' },
  REDEMPTION_EXPRESS_CORRECT: { label: '更正运单资料', group: 'SHIPPING', source: 'ORDER' },
  REDEMPTION_EXPRESS_PARCEL_SHIP: { label: '登记合包发货', group: 'SHIPPING', source: 'PARCEL' },
  REDEMPTION_EXPRESS_BATCH_SHIP: { label: '登记批量运单发货', group: 'SHIPPING', source: 'BATCH' },
  REDEMPTION_AFTER_SALES_REPLIED: { label: '回复售后反馈', group: 'RETURNS', source: 'ORDER' },
  REDEMPTION_AFTER_SALES_CLOSED: { label: '结束售后反馈', group: 'RETURNS', source: 'ORDER' },
  RETURN_APPROVE: { label: '批准退货退积分申请', group: 'RETURNS', source: 'ORDER' },
  RETURN_REJECT: { label: '拒绝退货退积分申请', group: 'RETURNS', source: 'ORDER' },
  RETURN_RECEIVE: { label: '登记退货隔离验收', group: 'RETURNS', source: 'ORDER' },
  RETURN_REFUND: { label: '退还售后积分', group: 'RETURNS', source: 'ORDER' },
  CUSTOMER_DISABLED: { label: '停用顾客账号', group: 'CUSTOMERS', source: 'CUSTOMER' },
  CUSTOMER_ENABLED: { label: '恢复顾客账号', group: 'CUSTOMERS', source: 'CUSTOMER' },
  CUSTOMER_NOTE_ADDED: { label: '新增顾客内部备注', group: 'CUSTOMERS', source: 'CUSTOMER' },
  POINTS_REPORT_EXPORT: { label: '生成积分报表文件', group: 'EXPORTS', source: 'EXPORT' },
  POINTS_POLICY: { label: '修改积分发放规则', group: 'SETTINGS', source: 'POLICY' },
  EXPRESS_POLICY: { label: '修改快递范围与运费', group: 'SETTINGS', source: 'POLICY' },
} as const;
export type MallAuditAction = keyof typeof MALL_AUDIT_ACTIONS;
export interface MallAuditEntry {
  id: string;
  action: MallAuditAction;
  group: MallAuditGroup;
  actorName: string;
  createdAt: string;
  sourceLabel: string;
}
export interface MallAuditPage {
  items: MallAuditEntry[];
  nextCursor: string | null;
}
export interface MallAuditDetail extends MallAuditEntry {
  requestId: string;
  orderNos: string[];
  exportSummary: {
    dataset: 'LEDGER' | 'DAILY';
    from: string;
    to: string;
    kind: string | null;
    rowCount: number;
    generatedAt: string;
  } | null;
}
