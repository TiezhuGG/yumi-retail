/** Internal boundary only. A future HTTP adapter must verify exact response bytes before
 * returning authenticated=true; this flag is never accepted from an API caller.
 * Query failures describe an observation, never the final payment/order state. */
export type PaymentQueryBinding = Readonly<{
  appId: string;
  merchantId: string;
  outTradeNo: string;
  total: number;
  currency: 'CNY';
}>;
export interface PaymentQueryAdapter {
  query(binding: PaymentQueryBinding, signal: AbortSignal): Promise<unknown>;
}
export type QueryClassification =
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'RATE_LIMIT'
  | 'SERVER_ERROR'
  | 'NOT_FOUND'
  | 'REJECTED'
  | 'INVALID_RESPONSE'
  | 'UNVERIFIED'
  | 'BINDING_MISMATCH'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'CLOSED'
  | 'UNSUPPORTED_STATE';
export type PaymentQueryObservation = Readonly<{
  classification: QueryClassification;
  evidence: 'UNKNOWN' | 'SUCCEEDED' | 'CLOSED';
  next: 'RETRY' | 'REVIEW' | 'RECONCILE';
  releaseAllowed: false;
}>;
function observation(
  classification: QueryClassification,
  next: PaymentQueryObservation['next'],
  evidence: PaymentQueryObservation['evidence'] = 'UNKNOWN',
): PaymentQueryObservation {
  return { classification, evidence, next, releaseAllowed: false };
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validBinding(b: PaymentQueryBinding) {
  return (
    [b.appId, b.merchantId, b.outTradeNo].every(
      (s) =>
        typeof s === 'string' &&
        s.length > 0 &&
        s.length <= 64 &&
        !Array.from(s).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127),
    ) &&
    Number.isSafeInteger(b.total) &&
    b.total > 0 &&
    b.currency === 'CNY'
  );
}
export function classifyPaymentQuery(
  binding: PaymentQueryBinding,
  input: unknown,
): PaymentQueryObservation {
  if (!validBinding(binding) || !record(input)) return observation('INVALID_RESPONSE', 'REVIEW');
  // No error response, including 404, is proof that no charge happened.
  if (
    !Number.isInteger(input.status) ||
    (input.status as number) < 100 ||
    (input.status as number) > 599
  )
    return observation('INVALID_RESPONSE', 'REVIEW');
  if (input.authenticated !== true) return observation('UNVERIFIED', 'REVIEW');
  if (input.status === 429 || (input.status === 403 && input.code === 'RULE_LIMIT'))
    return observation('RATE_LIMIT', 'RETRY');
  if ((input.status as number) >= 500) return observation('SERVER_ERROR', 'RETRY');
  if (input.status === 404 && input.code === 'ORDER_NOT_EXIST')
    return observation('NOT_FOUND', 'REVIEW');
  if (input.status !== 200) return observation('REJECTED', 'REVIEW');
  if (!record(input.trade)) return observation('INVALID_RESPONSE', 'REVIEW');
  const t = input.trade;
  if (
    ![t.appId, t.merchantId, t.outTradeNo].every((s) => typeof s === 'string') ||
    !Number.isSafeInteger(t.total) ||
    typeof t.currency !== 'string' ||
    typeof t.state !== 'string'
  )
    return observation('INVALID_RESPONSE', 'REVIEW');
  if (
    t.appId !== binding.appId ||
    t.merchantId !== binding.merchantId ||
    t.outTradeNo !== binding.outTradeNo ||
    t.total !== binding.total ||
    t.currency !== binding.currency
  )
    return observation('BINDING_MISMATCH', 'REVIEW');
  if (t.state === 'SUCCESS') {
    if (typeof t.transactionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.transactionId))
      return observation('INVALID_RESPONSE', 'REVIEW');
    return observation('SUCCEEDED', 'RECONCILE', 'SUCCEEDED');
  }
  if (t.state === 'CLOSED') return observation('CLOSED', 'RECONCILE', 'CLOSED');
  if (t.state === 'NOTPAY' || t.state === 'USERPAYING') return observation('PENDING', 'RETRY');
  return observation('UNSUPPORTED_STATE', 'REVIEW');
}
/** One query only; no internal retry, raw response/error retention, or database writes.
 * A timeout aborts cooperative adapters and discards any late result, even if they ignore abort. */
export async function executePaymentQuery(
  adapter: PaymentQueryAdapter,
  binding: PaymentQueryBinding,
  timeoutMs = 3000,
): Promise<PaymentQueryObservation> {
  if (!validBinding(binding) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    return observation('INVALID_RESPONSE', 'REVIEW');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Freeze a copy so an adapter cannot change the expected binding during the call.
    const expected = Object.freeze({ ...binding });
    return await Promise.race([
      Promise.resolve()
        .then(() => adapter.query(expected, controller.signal))
        .then(
          (r) => classifyPaymentQuery(expected, r),
          () => observation('TRANSPORT', 'RETRY'),
        ),
      new Promise<PaymentQueryObservation>((resolve) => {
        timer = setTimeout(() => {
          // Resolve first: a synchronous abort listener must not win as TRANSPORT.
          resolve(observation('TIMEOUT', 'RETRY'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch {
    return observation('INVALID_RESPONSE', 'REVIEW');
  } finally {
    clearTimeout(timer);
  }
}
