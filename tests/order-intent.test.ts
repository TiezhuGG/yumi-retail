import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  orderSubmission,
  parseOrderIntent,
  OrderIntentRejection,
} from '../apps/consumer-mini/src/order-intent.ts';
import type { OrderIntent } from '../apps/consumer-mini/src/order-intent.ts';
const user = randomUUID(),
  quote = randomUUID(),
  id = randomUUID();
test('intent is durable before request and unknown retries keep the same quote and key', async () => {
  let saved: OrderIntent | null = null,
    calls = 0,
    first: OrderIntent | undefined;
  const submit = orderSubmission({
    read: () => saved,
    write: (v) => {
      saved = structuredClone(v);
    },
    newKey: randomUUID,
    send: async (v) => {
      assert.ok(saved);
      calls++;
      if (!first) first = structuredClone(v);
      assert.equal(v.key, first.key);
      assert.equal(v.quoteId, quote);
      if (calls === 1) throw Error('network');
      return { id };
    },
  });
  await assert.rejects(() => submit.submit(user, quote));
  assert.equal(await submit.submit(user, randomUUID()), id);
  assert.equal(calls, 2);
  assert.equal((saved as OrderIntent | null)?.orderId, id);
});
test('storage failure prevents sending, and a different account cannot resume an intent', async () => {
  let calls = 0;
  const io = {
    read: () => null,
    write: () => {
      throw Error('storage');
    },
    newKey: randomUUID,
    send: async () => {
      calls++;
      return { id };
    },
  };
  await assert.rejects(() => orderSubmission(io).submit(user, quote));
  assert.equal(calls, 0);
  await assert.rejects(() =>
    orderSubmission({
      ...io,
      read: () => ({ version: 1, userId: randomUUID(), quoteId: quote, key: randomUUID() }),
    }).submit(user, quote),
  );
  assert.equal(calls, 0);
});
test('known order IDs resume without another create; failed success persistence keeps original retry key', async () => {
  let saved: OrderIntent | null = null,
    fail = true,
    calls = 0;
  const client = orderSubmission({
    read: () => saved,
    write: (v) => {
      if (v.orderId && fail) throw Error('full');
      saved = structuredClone(v);
    },
    newKey: randomUUID,
    send: async () => {
      calls++;
      return { id };
    },
  });
  await assert.rejects(() => client.submit(user, quote));
  const key = (saved as OrderIntent | null)?.key;
  fail = false;
  assert.equal(await client.submit(user, quote), id);
  assert.equal((saved as OrderIntent | null)?.key, key);
  assert.equal(await client.submit(user, quote), id);
  assert.equal(calls, 2);
});
test('authoritative rejection and session loss keep metadata until explicitly handled; corrupt data cannot be overwritten', async () => {
  let raw: unknown = { version: 1, userId: user, quoteId: quote, key: randomUUID() },
    writes = 0;
  const client = orderSubmission({
    read: () => raw,
    write: () => {
      writes++;
    },
    newKey: randomUUID,
    send: async () => {
      throw new OrderIntentRejection(409, 'changed');
    },
  });
  await assert.rejects(() => client.submit(user, quote), OrderIntentRejection);
  assert.equal(writes, 0);
  raw = { bad: true };
  await assert.rejects(() => client.submit(user, quote));
  assert.equal(writes, 0);
  assert.throws(() => parseOrderIntent(['bad']));
});
test('double click while sending does not issue a second request', async () => {
  let resolve!: (v: { id: string }) => void,
    saved: unknown,
    calls = 0;
  const client = orderSubmission({
    read: () => saved,
    write: (v) => {
      saved = v;
    },
    newKey: randomUUID,
    send: async () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
  });
  const pending = client.submit(user, quote);
  await assert.rejects(() => client.submit(user, quote));
  resolve({ id });
  assert.equal(await pending, id);
  assert.equal(calls, 1);
});
