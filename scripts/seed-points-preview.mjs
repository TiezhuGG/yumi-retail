import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../apps/api/dist/app.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { hashPassword } from '../packages/database/dist/index.js';

const url = new URL(process.env.DATABASE_URL ?? '');
const warehouseId = '00000000-0000-4000-8000-000000000002';
if (
  process.env.NODE_ENV !== 'development' ||
  process.env.PUBLIC_WAREHOUSE_ID !== warehouseId ||
  url.protocol !== 'postgresql:' ||
  url.host !== '127.0.0.1:55434' ||
  url.pathname !== '/yumi_dev' ||
  url.search ||
  url.hash ||
  process.env.LOCAL_ADMIN_LOGIN !== 'admin'
)
  throw Error('Use the isolated points preview database and its local administrator.');

const runtime = await createApplication(url.toString());
try {
  const administratorId = '00000000-0000-4000-8000-000000000003';
  const accounts = [
    [administratorId, 'admin', '本地管理员', 'SUPER_ADMIN', process.env.LOCAL_ADMIN_PASSWORD],
    [
      '00000000-0000-4000-8000-000000000006',
      'points.operator',
      '本地积分操作员',
      'OPERATIONS',
      process.env.LOCAL_POINTS_OPERATOR_PASSWORD,
    ],
  ];
  const staffRows = await Promise.all(
    accounts.map(async ([id, loginName, displayName, roleCode, password]) => ({
      id,
      loginName,
      displayName,
      roleCode,
      passwordHash: await hashPassword(password ?? ''),
    })),
  );
  await runtime.db.$transaction(async (tx) => {
    await tx.warehouse.upsert({
      where: { id: warehouseId },
      update: {},
      create: { id: warehouseId, code: 'POINTS-DEMO', name: '积分演示仓' },
    });
    for (const { roleCode, ...staff } of staffRows) {
      await tx.staff.upsert({
        where: { id: staff.id },
        update: {},
        create: {
          ...staff,
          roles: { create: { roleCode } },
          warehouses: { create: { warehouseId } },
        },
      });
    }
  });
  await runtime.app.listen(0, '127.0.0.1');
  const base = (await runtime.app.getUrl()) + '/api/v1';
  const origin = 'http://127.0.0.1:5173';
  async function request(path, headers = {}, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, path);
    return response;
  }
  const login = await request(
    '/staff/auth/session',
    {},
    {
      loginName: process.env.LOCAL_ADMIN_LOGIN,
      password: process.env.LOCAL_ADMIN_PASSWORD,
    },
  );
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { data: staff } = await (await request('/staff/me', { Cookie: cookie })).json();
  const catalog = new CatalogService(runtime.db, warehouseId);
  const ctx = {
    requestId: randomUUID(),
    staffContext: {
      staffId: administratorId,
      warehouseIds: [warehouseId],
    },
  };
  const groups = [
    ['纸品日用', ['抽纸', '卷纸', '厨房纸']],
    ['家居清洁', ['垃圾袋', '清洁布', '清洁刷']],
    ['衣物洗护', ['洗衣液', '洗衣皂', '洗衣袋']],
    ['厨房用品', ['保鲜袋', '洗碗海绵', '厨房手套']],
    ['个人清洁', ['洗手液', '香皂', '毛巾']],
    ['家居收纳', ['收纳袋', '衣架', '收纳盒']],
  ];
  const key = (number) => 'a4f00000-0000-4000-8000-' + String(number).padStart(12, '0');
  const reason = '本地积分商城演示';
  let sequence = 0;
  for (const [index, [name, products]] of groups.entries()) {
    const category = await catalog.createCategory(ctx, key(index + 1), { name, parentId: null });
    for (const title of products) {
      const i = ++sequence;
      const actionKey = key(100 + i);
      ctx.requestId = randomUUID();
      const product = await catalog.createProduct(ctx, actionKey, {
        categoryId: category.id,
        name: '演示' + title,
        description: reason,
        skus: [
          {
            code: 'POINTS-DEMO-' + i,
            spec: '单件装',
            unit: '件',
            priceCents: 500,
            expiryManaged: false,
          },
        ],
      });
      await catalog.productAction(ctx, actionKey, product.id, 0, true);
      const skuId = product.skus[0].id;
      const receipt = await catalog.createReceipt(ctx, actionKey, warehouseId, {
        sourceRef: 'POINTS-DEMO-' + i,
        lines: [
          {
            skuId,
            batchNo: 'POINTS-DEMO-' + i,
            quantity: 20,
            unitCostCents: 200,
            producedAt: null,
            expiresAt: null,
          },
        ],
      });
      await catalog.receiptAction(ctx, actionKey, warehouseId, receipt.id, 0, false);
      await catalog.receiptAction(ctx, actionKey, warehouseId, receipt.id, 1, true);
      const headers = {
        Cookie: cookie,
        'X-CSRF-Token': staff.csrfToken,
        'Idempotency-Key': actionKey,
      };
      const { data: reward } = await (
        await request('/admin/rewards/store/create', headers, {
          skuId,
          title: '演示' + title,
          pointsPrice: String(80 + i * 10),
          sortOrder: i,
          perUserLimit: 2,
          totalQuota: 20,
          startsAt: null,
          endsAt: null,
          reason,
        })
      ).json();
      await request('/admin/rewards/' + reward.id + '/publish', headers, { version: 0, reason });
    }
  }
  const { data } = await (await request('/rewards')).json();
  assert.equal(data.items.filter((item) => item.title.startsWith('演示')).length, 18);
  console.log('Points preview ready: 6 categories and 18 published rewards.');
} finally {
  await runtime.close();
}
