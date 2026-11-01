import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePaymentEvidence,
  paymentCloseDecision,
} from '../packages/database/src/payment-close-policy.ts';
const values = ['NONE', 'UNKNOWN', 'CLOSED', 'SUCCEEDED', 'CONFLICT'];
test('evidence merge is commutative, associative, idempotent and conflicts never disappear', () => {
  for (const a of values) {
    assert.equal(mergePaymentEvidence(a, a), a);
    for (const b of values) {
      assert.equal(mergePaymentEvidence(a, b), mergePaymentEvidence(b, a));
      for (const c of values)
        assert.equal(
          mergePaymentEvidence(mergePaymentEvidence(a, b), c),
          mergePaymentEvidence(a, mergePaymentEvidence(b, c)),
        );
    }
  }
  assert.equal(mergePaymentEvidence('CLOSED', 'SUCCEEDED'), 'CONFLICT');
  assert.equal(mergePaymentEvidence('SUCCEEDED', 'UNKNOWN'), 'SUCCEEDED');
  assert.equal(mergePaymentEvidence('CONFLICT', 'CLOSED'), 'CONFLICT');
});
test('only awaiting/not-started/no-evidence permits local release across the full supported state matrix', () => {
  for (const status of ['AWAITING_PAYMENT', 'CANCELED', 'PAID', 'INVALID'])
    for (const paymentState of ['NOT_STARTED', 'PENDING', 'PAID', 'INVALID'])
      for (const result of [...values, 'INVALID'])
        assert.equal(
          paymentCloseDecision({ status, paymentState }, result).releaseAllowed,
          status === 'AWAITING_PAYMENT' && paymentState === 'NOT_STARTED' && result === 'NONE',
        );
});
test('unknown results require querying and known close requires reconciliation, never direct release', () => {
  const order = { status: 'AWAITING_PAYMENT', paymentState: 'PENDING' };
  assert.equal(paymentCloseDecision(order, 'UNKNOWN').action, 'QUERY_CHANNEL');
  assert.equal(paymentCloseDecision(order, 'CLOSED').action, 'RECONCILE_CLOSE');
  assert.equal(paymentCloseDecision(order, 'NONE').action, 'REQUEST_CHANNEL_CLOSE');
});
test('success and close arriving in either order converge to conflict; replay cannot erase evidence', () => {
  for (const arrivals of [
    ['SUCCEEDED', 'UNKNOWN', 'CLOSED'],
    ['CLOSED', 'UNKNOWN', 'SUCCEEDED'],
  ]) {
    let result = 'NONE';
    for (const v of arrivals) result = mergePaymentEvidence(result, v);
    assert.equal(result, 'CONFLICT');
    assert.equal(
      paymentCloseDecision({ status: 'AWAITING_PAYMENT', paymentState: 'PENDING' }, result).action,
      'REVIEW_CONFLICT',
    );
  }
});
test('cancel-first late success and success-first cancellation cannot silently release or reopen', () => {
  assert.equal(
    paymentCloseDecision({ status: 'CANCELED', paymentState: 'NOT_STARTED' }, 'SUCCEEDED').action,
    'REVIEW_LATE_PAYMENT',
  );
  assert.equal(
    paymentCloseDecision({ status: 'AWAITING_PAYMENT', paymentState: 'PENDING' }, 'SUCCEEDED')
      .action,
    'RECONCILE_PAYMENT',
  );
  assert.equal(
    paymentCloseDecision({ status: 'PAID', paymentState: 'PAID' }, 'NONE').action,
    'NOOP_PAID',
  );
});
test('unsupported results and impossible paid snapshots fail closed', () => {
  assert.equal(mergePaymentEvidence('NONE', 'NOTPAY'), 'CONFLICT');
  assert.equal(
    paymentCloseDecision({ status: 'AWAITING_PAYMENT', paymentState: 'PAID' }, 'NONE').action,
    'REVIEW_CONFLICT',
  );
  assert.equal(
    paymentCloseDecision({ status: 'AWAITING_PAYMENT', paymentState: 'NOT_STARTED' }, 'SUCCEEDED')
      .action,
    'REVIEW_CONFLICT',
  );
});
