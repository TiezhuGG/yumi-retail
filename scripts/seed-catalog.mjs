import { randomUUID } from 'node:crypto';
import { createDatabase } from '../packages/database/dist/index.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname != '/yumi_dev' ||
  url.searchParams.has('schema')
)
  throw new Error('Catalog seed only permits local yumi_dev/public.');
const warehouseId = '00000000-0000-4000-8000-000000000002';
if (process.env.PUBLIC_WAREHOUSE_ID !== warehouseId)
  throw new Error('Configure the local demo public warehouse first.');
const db = createDatabase(url.toString());
try {
  const actor = await db.staff.findFirst({
    where: {
      id: '00000000-0000-4000-8000-000000000003',
      enabled: true,
      roles: { some: { roleCode: 'SUPER_ADMIN' } },
      warehouses: { some: { warehouseId } },
    },
  });
  if (!actor) throw new Error('Run db:seed first; enabled local administrator and scope required.');
  const service = new CatalogService(db, warehouseId);
  const request = {
    requestId: randomUUID(),
    staffContext: { staffId: actor.id, warehouseIds: [warehouseId] },
  };
  const category = await service.createCategory(request, '00000000-0000-4000-8000-000000000101', {
    name: '演示日用品',
    parentId: null,
  });
  if (typeof category !== 'object' || !category || !('id' in category))
    throw new Error('Invalid demo category result.');
  for (const [i, sample] of [
    { name: '演示垃圾袋', spec: '10只装', unit: '包', priceCents: 450, quantity: 10, cost: 200 },
    { name: '演示纸巾', spec: '1包', unit: '包', priceCents: 590, quantity: 8, cost: 300 },
    { name: '演示洗衣液', spec: '1瓶', unit: '瓶', priceCents: 1680, quantity: 6, cost: 900 },
  ].entries()) {
    request.requestId = randomUUID();
    const key = `00000000-0000-4000-8000-00000000020${i}`;
    const product = await service.createProduct(request, key, {
      categoryId: category.id,
      name: sample.name,
      description: '合成开发样例，不代表真实经营商品',
      skus: [
        {
          code: `YUMI-DEMO-${i + 1}`,
          spec: sample.spec,
          unit: sample.unit,
          priceCents: sample.priceCents,
          expiryManaged: false,
        },
      ],
    });
    await service.productAction(request, key, product.id, 0, true);
    const receipt = await service.createReceipt(request, key, warehouseId, {
      sourceRef: `开发样例收货-${i + 1}`,
      lines: [
        {
          skuId: product.skus[0].id,
          batchNo: `DEMO-${i + 1}`,
          quantity: sample.quantity,
          unitCostCents: sample.cost,
          producedAt: null,
          expiresAt: null,
        },
      ],
    });
    await service.receiptAction(request, key, warehouseId, receipt.id, 0, false);
    await service.receiptAction(request, key, warehouseId, receipt.id, 1, true);
  }
  console.log(
    'Three synthetic catalog/inbound examples ready. Replays do not overwrite stock or product state.',
  );
} finally {
  await db.$disconnect();
}
