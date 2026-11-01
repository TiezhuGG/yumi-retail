import { mergePaymentEvidence, paymentCloseDecision } from '@yumi/database';
const waiting = { status: 'AWAITING_PAYMENT', paymentState: 'NOT_STARTED' },
  pending = { ...waiting, paymentState: 'PENDING' },
  canceled = { status: 'CANCELED', paymentState: 'NOT_STARTED' },
  paid = { status: 'PAID', paymentState: 'PAID' };
export const paymentCloseCases = [
  {
    code: 'UNSTARTED',
    title: '未调用渠道才允许本地释放',
    run: () => paymentCloseDecision(waiting, 'NONE').releaseAllowed,
  },
  {
    code: 'PENDING',
    title: '已发起支付先请求渠道关闭',
    run: () => paymentCloseDecision(pending, 'NONE').action === 'REQUEST_CHANNEL_CLOSE',
  },
  {
    code: 'UNKNOWN',
    title: '未知结果保留预占并查单',
    run: () => paymentCloseDecision(pending, 'UNKNOWN').action === 'QUERY_CHANNEL',
  },
  {
    code: 'CONFIRMED_CLOSE',
    title: '渠道关闭仍需事务核对后处理',
    run: () =>
      paymentCloseDecision(pending, 'CLOSED').action === 'RECONCILE_CLOSE' &&
      !paymentCloseDecision(pending, 'CLOSED').releaseAllowed,
  },
  {
    code: 'SUCCESS_FIRST',
    title: '成功结果禁止直接释放库存',
    run: () =>
      paymentCloseDecision(pending, 'SUCCEEDED').action === 'RECONCILE_PAYMENT' &&
      !paymentCloseDecision(pending, 'SUCCEEDED').releaseAllowed,
  },
  {
    code: 'LATE_SUCCESS',
    title: '取消后迟到成功进入人工核查预案',
    run: () => paymentCloseDecision(canceled, 'SUCCEEDED').action === 'REVIEW_LATE_PAYMENT',
  },
  {
    code: 'PAID',
    title: '已支付判定禁止取消释放',
    run: () => paymentCloseDecision(paid, 'NONE').action === 'NOOP_PAID',
  },
  {
    code: 'REPEAT_CANCEL',
    title: '已取消重复关闭不重复释放',
    run: () => paymentCloseDecision(canceled, 'NONE').action === 'NOOP_CANCELED',
  },
  {
    code: 'RESULT_RACE',
    title: '成功与关闭两种到达顺序都标记冲突',
    run: () =>
      ['CLOSED', 'SUCCEEDED'].every((first) => {
        const next = first === 'CLOSED' ? 'SUCCEEDED' : 'CLOSED';
        return (
          paymentCloseDecision(pending, mergePaymentEvidence(first, next)).action ===
          'REVIEW_CONFLICT'
        );
      }),
  },
  {
    code: 'NO_DOWNGRADE',
    title: '未知或重复结果不覆盖已知证据',
    run: () =>
      mergePaymentEvidence('SUCCEEDED', 'UNKNOWN') === 'SUCCEEDED' &&
      mergePaymentEvidence('CLOSED', 'CLOSED') === 'CLOSED' &&
      mergePaymentEvidence('CONFLICT', 'NONE') === 'CONFLICT',
  },
  {
    code: 'INVALID',
    title: '未知状态和不一致快照默认阻断',
    run: () =>
      paymentCloseDecision({ ...waiting, paymentState: 'PAID' }, 'NONE').action ===
        'REVIEW_CONFLICT' && !paymentCloseDecision(waiting, 'NOTPAY').releaseAllowed,
  },
  {
    code: 'UNEXPECTED',
    title: '未发起支付却收到成功不能直接入账',
    run: () => paymentCloseDecision(waiting, 'SUCCEEDED').action === 'REVIEW_CONFLICT',
  },
];
export function runPaymentCloseSelfTest() {
  return {
    completedAt: new Date().toISOString(),
    syntheticOnly: true as const,
    callbackEnabled: false as const,
    results: paymentCloseCases.map(({ code, title, run }) => {
      let passed = false;
      try {
        passed = run();
      } catch {
        /* no secrets or internal errors returned */
      }
      return { code, title, status: passed ? ('PASSED' as const) : ('FAILED' as const) };
    }),
  };
}
