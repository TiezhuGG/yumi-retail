import { Prisma } from '@yumi/database';
import { failure } from './http.js';
export async function inventoryLocks(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  ids: string[],
) {
  for (const id of ids) {
    await tx.$queryRaw`SELECT sku_id FROM stock_balances WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${id}::uuid FOR UPDATE`;
  }
  for (const id of ids) {
    await tx.$queryRaw`SELECT id FROM stock_lots WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${id}::uuid ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM stock_positions WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${id}::uuid ORDER BY id FOR UPDATE`;
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM warehouse_locations WHERE warehouse_id=${warehouseId}::uuid AND id IN (SELECT location_id FROM stock_positions WHERE warehouse_id=${warehouseId}::uuid AND sku_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})) ORDER BY id FOR SHARE`,
  );
}
export async function metadataLocks(tx: Prisma.TransactionClient, ids: string[]) {
  const skus = await tx.sku.findMany({
    where: { id: { in: ids } },
    select: { id: true, productId: true },
  });
  if (skus.length !== ids.length) throw failure(409, 'QUOTE_CHANGED', '商品已失效，请重新报价');
  const productIds = [...new Set(skus.map((s) => s.productId))].sort();
  for (const id of productIds)
    await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR SHARE`;
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    select: { categoryId: true },
  });
  const categories = await tx.category.findMany({
    where: { id: { in: products.map((p) => p.categoryId) } },
    select: { id: true, parentId: true },
  });
  const categoryIds = [
    ...new Set(categories.flatMap((c) => [c.id, ...(c.parentId ? [c.parentId] : [])])),
  ].sort();
  for (const id of categoryIds)
    await tx.$queryRaw`SELECT id FROM categories WHERE id=${id}::uuid FOR SHARE`;
  for (const id of ids) await tx.$queryRaw`SELECT id FROM skus WHERE id=${id}::uuid FOR SHARE`;
}
