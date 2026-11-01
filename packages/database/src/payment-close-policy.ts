// Pure reconciliation plan only. No channel calls, paid transitions or refunds.
export type PaymentEvidence = 'NONE' | 'UNKNOWN' | 'CLOSED' | 'SUCCEEDED' | 'CONFLICT';
const evidence = new Set(['NONE', 'UNKNOWN', 'CLOSED', 'SUCCEEDED', 'CONFLICT']);
export function mergePaymentEvidence(current: string, incoming: string): PaymentEvidence {
  if (!evidence.has(current) || !evidence.has(incoming)) return 'CONFLICT';
  if (current === 'CONFLICT' || incoming === 'CONFLICT') return 'CONFLICT';
  if (
    (current === 'CLOSED' && incoming === 'SUCCEEDED') ||
    (current === 'SUCCEEDED' && incoming === 'CLOSED')
  )
    return 'CONFLICT';
  if (current === 'SUCCEEDED' || incoming === 'SUCCEEDED') return 'SUCCEEDED';
  if (current === 'CLOSED' || incoming === 'CLOSED') return 'CLOSED';
  if (current === 'UNKNOWN' || incoming === 'UNKNOWN') return 'UNKNOWN';
  return 'NONE';
}
export type PaymentCloseAction =
  | 'RELEASE_LOCAL'
  | 'NOOP_CANCELED'
  | 'NOOP_PAID'
  | 'QUERY_CHANNEL'
  | 'REQUEST_CHANNEL_CLOSE'
  | 'RECONCILE_CLOSE'
  | 'RECONCILE_PAYMENT'
  | 'REVIEW_LATE_PAYMENT'
  | 'REVIEW_CONFLICT';
export function paymentCloseDecision(
  order: { status: string; paymentState: string },
  result: string,
): { action: PaymentCloseAction; releaseAllowed: boolean } {
  const plan = (action: PaymentCloseAction) => ({
    action,
    releaseAllowed: action === 'RELEASE_LOCAL',
  });
  if (
    !['AWAITING_PAYMENT', 'CANCELED', 'PAID'].includes(order.status) ||
    !['NOT_STARTED', 'PENDING', 'PAID'].includes(order.paymentState) ||
    !evidence.has(result) ||
    result === 'CONFLICT'
  )
    return plan('REVIEW_CONFLICT');
  if ((order.status === 'PAID') !== (order.paymentState === 'PAID')) return plan('REVIEW_CONFLICT');
  if (order.status === 'PAID') return plan(result === 'CLOSED' ? 'REVIEW_CONFLICT' : 'NOOP_PAID');
  if (order.status === 'CANCELED') {
    if (result === 'SUCCEEDED') return plan('REVIEW_LATE_PAYMENT');
    if (result === 'UNKNOWN' || order.paymentState !== 'NOT_STARTED')
      return plan('REVIEW_CONFLICT');
    return plan('NOOP_CANCELED');
  }
  if (result === 'SUCCEEDED')
    return plan(order.paymentState === 'PENDING' ? 'RECONCILE_PAYMENT' : 'REVIEW_CONFLICT');
  if (result === 'UNKNOWN') return plan('QUERY_CHANNEL');
  if (result === 'CLOSED')
    return plan(order.paymentState === 'PENDING' ? 'RECONCILE_CLOSE' : 'REVIEW_CONFLICT');
  return plan(order.paymentState === 'NOT_STARTED' ? 'RELEASE_LOCAL' : 'REQUEST_CHANNEL_CLOSE');
}
