import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPaymentQuery,
  executePaymentQuery,
} from '../apps/api/src/payment-query-adapter.ts';
import {
  adapterFixtureBinding as binding,
  runPaymentAdapterSelfTest,
} from '../apps/api/src/payment-adapter-fixtures.ts';
const response = (patch: Record<string, unknown> = {}) => ({
  status: 200,
  authenticated: true,
  trade: { ...binding, state: 'SUCCESS', transactionId: 'synthetic-id', ...patch },
});
test('all 17 classifications satisfy expected evidence/action and never release inventory', async () => {
  const r = await runPaymentAdapterSelfTest();
  assert.equal(r.results.length, 17);
  assert.ok(r.results.every((x) => x.status === 'PASSED' && !x.releaseAllowed));
  assert.ok(!JSON.stringify(r).includes('synthetic-private-error'));
});
test('each binding field, integer amount, currency and transaction id is checked before known evidence', () => {
  for (const patch of [
    { appId: 'other' },
    { merchantId: 'other' },
    { outTradeNo: 'other' },
    { total: 102 },
    { currency: 'USD' },
  ]) {
    assert.equal(classifyPaymentQuery(binding, response(patch)).classification, 'BINDING_MISMATCH');
  }
  for (const patch of [
    { total: '101' },
    { total: 101.1 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { transactionId: null },
    { transactionId: '\nraw' },
  ]) {
    assert.equal(classifyPaymentQuery(binding, response(patch)).evidence, 'UNKNOWN');
  }
  for (const state of ['REFUND', 'REVOKED', 'PAYERROR', 'NEW_STATE'])
    assert.equal(
      classifyPaymentQuery(binding, response({ state })).classification,
      'UNSUPPORTED_STATE',
    );
});
test('untrusted errors cannot bypass authenticity and malformed success is not accepted', () => {
  for (const status of [200, 403, 404, 429, 500])
    assert.equal(
      classifyPaymentQuery(binding, { ...response(), status, authenticated: false }).classification,
      'UNVERIFIED',
    );
  for (const input of [
    null,
    [],
    {},
    { status: '200' },
    { status: 999 },
    { status: 200, authenticated: true },
    { ...response(), authenticated: 'true' },
  ])
    assert.equal(classifyPaymentQuery(binding, input).evidence, 'UNKNOWN');
});
test('timeout aborts exactly one query and ignores late success without unhandled rejection', async () => {
  let calls = 0,
    signal: AbortSignal | undefined,
    finish: ((r: unknown) => void) | undefined;
  const r = await executePaymentQuery(
    {
      query: async (_, s) => {
        calls++;
        signal = s;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    binding,
    5,
  );
  assert.equal(r.classification, 'TIMEOUT');
  assert.equal(signal?.aborted, true);
  finish?.(response());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(r.evidence, 'UNKNOWN');
});
test('synchronous abort rejection remains timeout; sync throw and raw secrets are sanitized', async () => {
  const r = await executePaymentQuery(
    {
      query: async (_, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Error('sensitive')));
        }),
    },
    binding,
    5,
  );
  assert.equal(r.classification, 'TIMEOUT');
  const thrown = await executePaymentQuery(
    {
      query: () => {
        throw Error('sensitive');
      },
    },
    binding,
  );
  assert.deepEqual(thrown, {
    classification: 'TRANSPORT',
    evidence: 'UNKNOWN',
    next: 'RETRY',
    releaseAllowed: false,
  });
  const raw = await executePaymentQuery(
    { query: async () => ({ ...response(), rawBody: 'sensitive', headers: 'sensitive' }) },
    binding,
  );
  assert.ok(!JSON.stringify(raw).includes('sensitive'));
});
test('invalid timeout or expected identity prevents adapter call; expected binding cannot be mutated', async () => {
  let calls = 0;
  const adapter = {
    query: async () => {
      calls++;
      return response();
    },
  };
  for (const timeout of [0, -1, 10001, NaN, 1.1])
    assert.equal(
      (await executePaymentQuery(adapter, binding, timeout)).classification,
      'INVALID_RESPONSE',
    );
  for (const patch of [{ total: 0 }, { appId: '' }, { outTradeNo: 'bad\n' }])
    assert.equal(
      (await executePaymentQuery(adapter, { ...binding, ...patch })).classification,
      'INVALID_RESPONSE',
    );
  assert.equal(calls, 0);
  await executePaymentQuery(
    {
      query: async (expected) => {
        assert.equal(Object.isFrozen(expected), true);
        assert.notEqual(expected, binding);
        return response();
      },
    },
    binding,
  );
});
