// Explicitly local demo catalogue setup; existing catalogue/stock and transaction gates stay intact.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createApplication } from '../apps/api/dist/app.js';

export function assertLocalRewardSeed(env, args) {
  let url;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw Error('A valid local development database is required.');
  }
  if (
    env.NODE_ENV !== 'development' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55432' ||
    url.pathname !== '/yumi_dev' ||
    url.search ||
    url.hash ||
    env.PUBLIC_WAREHOUSE_ID !== '00000000-0000-4000-8000-000000000002' ||
    env.PAYMENT_MODE !== 'disabled' ||
    args.length !== 1 ||
    args[0] !== '--apply'
  )
    throw Error('Requires --apply, development and the local yumi_dev/public demo warehouse.');
  if (!env.LOCAL_ADMIN_LOGIN || !env.LOCAL_ADMIN_PASSWORD)
    throw Error('Local administrator credentials are required; no account is created or reset.');
  return url.toString();
}

export async function seedLocalRewards(env, args) {
  const runtime = await createApplication(assertLocalRewardSeed(env, args));
  try {
    // Do not write balances or fabricate stock merely to make a product visible.
    async function sourceDigest() {
      const result = {};
      for (const table of [
        'products',
        'skus',
        'categories',
        'stock_balances',
        'stock_lots',
        'stock_positions',
        'stock_ledger',
        'position_ledger',
      ]) {
        const rows = await runtime.db.$queryRawUnsafe(
          `SELECT md5(coalesce(string_agg(j,chr(10) ORDER BY j),'')) AS hash FROM (SELECT row_to_json(x)::text AS j FROM "${table}" x) q`,
        );
        result[table] = rows[0].hash;
      }
      return result;
    }
    const before = await sourceDigest();
    const dbRewards = await runtime.db.rewardProduct.count();
    if (dbRewards) {
      console.log(
        JSON.stringify({
          created: 0,
          existing: dbRewards,
          message: 'Existing rewards preserved; no republish, price change or replenishment.',
        }),
      );
      return;
    }
    await runtime.app.listen(0, '127.0.0.1');
    const base = (await runtime.app.getUrl()) + '/api/v1',
      origin = 'http://127.0.0.1:5173';
    async function call(path, body, headers = {}) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (response.status !== 200)
        throw Error(path + ': ' + response.status + ' ' + (result.error?.code ?? 'UNKNOWN'));
      return { response, data: result.data };
    }
    const { data: catalog } = await call('/products?limit=20');
    const samples = new Map([
      ['演示垃圾袋', '80'],
      ['演示纸巾', '120'],
      ['演示洗衣液', '300'],
    ]);
    const selected = catalog.items.filter((p) => samples.has(p.name) && p.available > 0);
    if (!selected.length)
      throw Error('No existing sellable demo SKUs; no inventory has been added.');
    const { response: login } = await call('/staff/auth/session', {
      loginName: env.LOCAL_ADMIN_LOGIN,
      password: env.LOCAL_ADMIN_PASSWORD,
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Local login cookie required');
    const { data: profile } = await call('/staff/me', undefined, { Cookie: cookie });
    try {
      for (const [index, p] of selected.entries()) {
        const hash = createHash('sha256')
          .update('local-reward-demo-v1:' + p.id)
          .digest('hex');
        const key =
          hash.slice(0, 8) +
          '-' +
          hash.slice(8, 12) +
          '-4' +
          hash.slice(13, 16) +
          '-8' +
          hash.slice(17, 20) +
          '-' +
          hash.slice(20, 32);
        const headers = {
          Cookie: cookie,
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': key,
        };
        const reason = '2026-11-05 本地演示商品，仅用于界面验证，非正式经营配置';
        const { data: reward } = await call(
          '/admin/rewards/store/create',
          {
            skuId: p.id,
            title: p.name,
            pointsPrice: samples.get(p.name),
            sortOrder: (index + 1) * 10,
            perUserLimit: 2,
            totalQuota: 20,
            startsAt: null,
            endsAt: null,
            reason,
          },
          headers,
        );
        await call('/admin/rewards/' + reward.id + '/publish', { version: 0, reason }, headers);
      }
      assert.deepEqual(
        await sourceDigest(),
        before,
        'Existing catalogue and all stock evidence must stay unchanged',
      );
      const { data: page } = await call('/rewards');
      assert.equal(page.items.length, selected.length);
      console.log(
        JSON.stringify({
          created: selected.length,
          items: page.items.map((p) => ({
            title: p.title,
            pointsPrice: p.pointsPrice,
            available: p.available,
            redemptionEnabled: p.redemptionEnabled,
          })),
          sourceStockUnchanged: true,
        }),
      );
    } finally {
      await call('/staff/auth/logout', {}, { Cookie: cookie, 'X-CSRF-Token': profile.csrfToken });
    }
  } finally {
    await runtime.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedLocalRewards(process.env, process.argv.slice(2));
}
