import {
  executePaymentQuery,
  type PaymentQueryAdapter,
  type QueryClassification,
} from './payment-query-adapter.js';
export const adapterFixtureBinding = Object.freeze({
  appId: 'synthetic-app',
  merchantId: 'synthetic-merchant',
  outTradeNo: 'synthetic-query',
  total: 101,
  currency: 'CNY' as const,
});
const trade = {
  ...adapterFixtureBinding,
  state: 'SUCCESS',
  transactionId: 'synthetic-transaction',
};
const response = (patch: Record<string, unknown> = {}) => ({
  status: 200,
  authenticated: true,
  trade: { ...trade, ...patch },
});
function value(input: unknown): PaymentQueryAdapter {
  return { query: async () => input };
}
export const paymentAdapterCases: {
  code: string;
  title: string;
  adapter: PaymentQueryAdapter;
  expected: QueryClassification;
  evidence: 'UNKNOWN' | 'SUCCEEDED' | 'CLOSED';
  next: 'RETRY' | 'REVIEW' | 'RECONCILE';
  timeout?: number;
}[] = [
  {
    code: 'SUCCESS',
    title: '可信成功仍需事务核对后入账',
    adapter: value(response()),
    expected: 'SUCCEEDED',
    evidence: 'SUCCEEDED',
    next: 'RECONCILE',
  },
  {
    code: 'CLOSED',
    title: '可信关闭仍不直接释放库存',
    adapter: value(response({ state: 'CLOSED' })),
    expected: 'CLOSED',
    evidence: 'CLOSED',
    next: 'RECONCILE',
  },
  {
    code: 'NOTPAY',
    title: '未支付继续保留未知并查单',
    adapter: value(response({ state: 'NOTPAY' })),
    expected: 'PENDING',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'USERPAYING',
    title: '支付中不推断为失败',
    adapter: value(response({ state: 'USERPAYING' })),
    expected: 'PENDING',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'TIMEOUT',
    title: '超时中止等待，迟到结果不采纳',
    adapter: { query: async () => new Promise(() => {}) },
    timeout: 5,
    expected: 'TIMEOUT',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'NETWORK',
    title: '网络异常保留未知，不返回原始错误',
    adapter: {
      query: async () => {
        throw Error('synthetic-private-error');
      },
    },
    expected: 'TRANSPORT',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'RATE',
    title: 'HTTP限流等待外层重新安排',
    adapter: value({ status: 429, authenticated: true }),
    expected: 'RATE_LIMIT',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'RULE',
    title: '业务频率限制可重新安排',
    adapter: value({ status: 403, code: 'RULE_LIMIT', authenticated: true }),
    expected: 'RATE_LIMIT',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'SERVER',
    title: '渠道系统异常不改变支付状态',
    adapter: value({ status: 500, authenticated: true }),
    expected: 'SERVER_ERROR',
    evidence: 'UNKNOWN',
    next: 'RETRY',
  },
  {
    code: 'MISSING',
    title: '订单不存在先核查创建记录',
    adapter: value({ status: 404, code: 'ORDER_NOT_EXIST', authenticated: true }),
    expected: 'NOT_FOUND',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'REJECTED',
    title: '查询被拒绝不等于扣款失败',
    adapter: value({ status: 401, authenticated: true }),
    expected: 'REJECTED',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'UNVERIFIED',
    title: '未经验证的成功响应被阻断',
    adapter: value({ ...response(), authenticated: false }),
    expected: 'UNVERIFIED',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'BINDING',
    title: '订单号不匹配转核查',
    adapter: value(response({ outTradeNo: 'other-synthetic-query' })),
    expected: 'BINDING_MISMATCH',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'AMOUNT',
    title: '金额相差一分也不能确认成功',
    adapter: value(response({ total: 102 })),
    expected: 'BINDING_MISMATCH',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'MALFORMED',
    title: '格式异常不猜测支付结果',
    adapter: value({ status: 200, authenticated: true, trade: null }),
    expected: 'INVALID_RESPONSE',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'NO_TRANSACTION',
    title: '成功缺少渠道交易号被阻断',
    adapter: value(response({ transactionId: '' })),
    expected: 'INVALID_RESPONSE',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
  {
    code: 'UNSUPPORTED',
    title: '未知或退款状态转核查',
    adapter: value(response({ state: 'REFUND' })),
    expected: 'UNSUPPORTED_STATE',
    evidence: 'UNKNOWN',
    next: 'REVIEW',
  },
];
export async function runPaymentAdapterSelfTest() {
  const results = await Promise.all(
    paymentAdapterCases.map(async (c) => {
      const result = await executePaymentQuery(c.adapter, adapterFixtureBinding, c.timeout);
      const passed =
        result.classification === c.expected &&
        result.evidence === c.evidence &&
        result.next === c.next &&
        !result.releaseAllowed;
      return {
        code: c.code,
        title: c.title,
        status: passed ? ('PASSED' as const) : ('FAILED' as const),
        ...result,
      };
    }),
  );
  return {
    completedAt: new Date().toISOString(),
    syntheticOnly: true as const,
    callbackEnabled: false as const,
    results,
  };
}
