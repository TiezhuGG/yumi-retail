// Additional sample assortment, through real catalogue and receipt services; never replenishes on replay.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from '../apps/api/dist/app.js';
import { assertLocalRewardSeed } from './seed-rewards-local.mjs';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
const runtime = await createApplication(assertLocalRewardSeed(process.env, process.argv.slice(2)));
try {
  const replay =
    (await runtime.db.sku.count({ where: { code: { startsWith: 'MALL-SAMPLE-' } } })) === 18;
  async function inventoryDigest() {
    const rows = await runtime.db.$queryRawUnsafe(
      `SELECT md5(coalesce(string_agg(j,chr(10) ORDER BY j),'')) AS hash FROM (SELECT row_to_json(s)::text AS j FROM stock_balances s UNION ALL SELECT row_to_json(l)::text FROM stock_lots l UNION ALL SELECT row_to_json(p)::text FROM stock_positions p UNION ALL SELECT row_to_json(e)::text FROM stock_ledger e UNION ALL SELECT row_to_json(x)::text FROM position_ledger x) q`,
    );
    return rows[0].hash;
  }
  const before = await inventoryDigest();
  await runtime.app.listen(0, '127.0.0.1');
  const base = (await runtime.app.getUrl()) + '/api/v1',
    origin = 'http://127.0.0.1:5173';
  async function call(path, body, headers = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (r.status !== 200) throw Error(path + ':' + r.status + ' ' + j.error?.code);
    return { r, data: j.data };
  }
  const { r } = await call('/staff/auth/session', {
      loginName: process.env.LOCAL_ADMIN_LOGIN,
      password: process.env.LOCAL_ADMIN_PASSWORD,
    }),
    cookie = r.headers.get('set-cookie').split(';')[0];
  const { data: profile } = await call('/staff/me', undefined, { Cookie: cookie });
  const ctx = {
    requestId: randomUUID(),
    staffContext: {
      staffId: profile.id,
      sessionId: profile.sessionId,
      warehouseIds: [process.env.PUBLIC_WAREHOUSE_ID],
    },
  };
  const catalog = new CatalogService(runtime.db, process.env.PUBLIC_WAREHOUSE_ID);
  const key = (s) => {
    const h = createHash('sha256')
      .update('mall-assortment-v1:' + s)
      .digest('hex');
    return (
      h.slice(0, 8) +
      '-' +
      h.slice(8, 12) +
      '-4' +
      h.slice(13, 16) +
      '-8' +
      h.slice(17, 20) +
      '-' +
      h.slice(20, 32)
    );
  };
  const groups = [
    ['纸品日用', ['抽纸', '卷纸', '厨房纸']],
    ['家居清洁', ['加厚垃圾袋', '清洁布', '清洁刷']],
    ['衣物洗护', ['浓缩洗衣液', '洗衣皂', '洗衣袋']],
    ['厨房用品', ['保鲜袋', '洗碗海绵', '厨房手套']],
    ['个人清洁', ['洗手液', '香皂', '毛巾']],
    ['家居收纳', ['收纳袋', '衣架', '收纳盒']],
  ];
  let count = 0;
  try {
    for (const [group, products] of groups) {
      const category = await catalog.createCategory(ctx, key(group), {
        name: group,
        parentId: null,
      });
      for (const title of products) {
        ++count;
        const k = key(title);
        ctx.requestId = randomUUID();
        const p = await catalog.createProduct(ctx, k, {
          categoryId: category.id,
          name: '演示' + title,
          description: '本地积分商城演示样例，不代表真实在售商品或已确认经营参数。',
          skus: [
            {
              code: 'MALL-SAMPLE-' + count,
              spec: '单件装',
              unit: '件',
              priceCents: 500,
              expiryManaged: false,
            },
          ],
        });
        await catalog.productAction(ctx, k, p.id, 0, true);
        const skuId = p.skus[0].id;
        const receipt = await catalog.createReceipt(ctx, k, process.env.PUBLIC_WAREHOUSE_ID, {
          sourceRef: '本地商城样例-' + count,
          lines: [
            {
              skuId,
              batchNo: 'MALL-SAMPLE-' + count,
              quantity: 20,
              unitCostCents: 200,
              producedAt: null,
              expiresAt: null,
            },
          ],
        });
        await catalog.receiptAction(ctx, k, process.env.PUBLIC_WAREHOUSE_ID, receipt.id, 0, false);
        await catalog.receiptAction(ctx, k, process.env.PUBLIC_WAREHOUSE_ID, receipt.id, 1, true);
        const headers = { Cookie: cookie, 'X-CSRF-Token': profile.csrfToken, 'Idempotency-Key': k },
          reason = '本地演示配置，正式上线前须确认';
        const { data: reward } = await call(
          '/admin/rewards/store/create',
          {
            skuId,
            title: '演示' + title,
            pointsPrice: String(80 + count * 20),
            sortOrder: 100 + count,
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
    }
    if (replay)
      assert.equal(
        await inventoryDigest(),
        before,
        'Replay must not replenish or rewrite inventory',
      );
    console.log(
      JSON.stringify({
        replay,
        sampleGroups: groups.length,
        sampleRewards: count,
        published: await runtime.db.rewardProduct.count({ where: { status: 'PUBLISHED' } }),
      }),
    );
  } finally {
    await call('/staff/auth/logout', {}, { Cookie: cookie, 'X-CSRF-Token': profile.csrfToken });
  }
} finally {
  await runtime.close();
}
