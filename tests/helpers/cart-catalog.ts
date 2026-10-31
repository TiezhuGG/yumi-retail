// Disposable test-schema fixture only: use the real receipt service to seed consistent saleable stock.
import { randomUUID } from 'node:crypto';
import type { createApplication } from '../../apps/api/dist/app.js';
import { CatalogService } from '../../apps/api/dist/catalog-service.js';
import type { ApiRequest } from '../../apps/api/dist/http.js';
export async function seedCartCatalog(
  runtime: Awaited<ReturnType<typeof createApplication>>,
  warehouseId: string,
  existingWarehouse = false,
) {
  const db = runtime.db;
  if (!existingWarehouse)
    await db.warehouse.create({
      data: { id: warehouseId, code: 'CART-TEST', name: '购物车隔离测试仓' },
    });
  const category = await db.category.create({ data: { id: randomUUID(), name: '购物车测试分类' } });
  const product = await db.product.create({
    data: {
      id: randomUUID(),
      categoryId: category.id,
      name: '合成纸巾',
      description: '隔离测试',
      status: 'PUBLISHED',
    },
  });
  const skuIds = [randomUUID(), randomUUID()];
  await db.sku.createMany({
    data: skuIds.map((id, i) => ({
      id,
      productId: product.id,
      code: 'CART-' + i,
      spec: i ? '3包装' : '单包装',
      unit: i ? '组' : '包',
      priceCents: i ? 1299 : 450,
      expiryManaged: false,
    })),
  });
  const staffIds = [randomUUID(), randomUUID()];
  await db.staff.createMany({
    data: staffIds.map((id, i) => ({
      id,
      loginName: 'cart-fixture-' + i,
      displayName: '测试员工' + i,
      passwordHash: 'unused-test-fixture-no-login',
    })),
  });
  const service = new CatalogService(db, warehouseId);
  const request = (i: number): ApiRequest => ({
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    requestId: randomUUID(),
    staffContext: {
      sessionId: randomUUID(),
      staffId: staffIds[i]!,
      loginName: 'fixture',
      displayName: '测试员工',
      roles: ['SUPER_ADMIN'],
      permissions: [],
      warehouseIds: [warehouseId],
      csrfToken: '',
    },
  });
  const sourceRef = randomUUID();
  await service.createReceipt(request(0), randomUUID(), warehouseId, {
    sourceRef,
    lines: skuIds.map((skuId, i) => ({
      skuId,
      batchNo: 'CART-' + i,
      quantity: 5,
      unitCostCents: 100,
      producedAt: null,
      expiresAt: null,
    })),
  });
  const receipt = await db.inboundReceipt.findFirstOrThrow({ where: { sourceRef } });
  await service.receiptAction(request(1), randomUUID(), warehouseId, receipt.id, 0, false);
  await service.receiptAction(request(0), randomUUID(), warehouseId, receipt.id, 1, true);
  return { skuIds, productId: product.id, categoryId: category.id };
}
