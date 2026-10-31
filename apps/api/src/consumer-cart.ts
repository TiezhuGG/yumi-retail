import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { Prisma } from '@yumi/database';
import type { ConsumerCart, ConsumerCartItem, CartMergeResult } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, integer, str, uuid } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
import { tokenHash } from './staff-auth.js';
const labels = (row: Record<string, unknown>) => ({
  name: str(row.name, 120),
  spec: str(row.spec, 100),
  unit: str(row.unit, 16),
});
const selected = (v: unknown) => {
  if (typeof v !== 'boolean') throw failure(400, 'VALIDATION_ERROR', '勾选状态必须为布尔值');
  return v;
};
export function cartItems(value: unknown): ConsumerCartItem[] {
  if (!Array.isArray(value) || value.length > 50)
    throw failure(400, 'VALIDATION_ERROR', '草稿最多50种规格');
  const items = value.map((v) => {
    const row = fields(v, ['skuId', 'quantity', 'selected', 'name', 'spec', 'unit']);
    return {
      skuId: uuid(row.skuId),
      quantity: integer(row.quantity, 1, 200),
      selected: selected(row.selected),
      ...labels(row),
    };
  });
  if (
    new Set(items.map((i) => i.skuId)).size !== items.length ||
    items.reduce((n, i) => n + i.quantity, 0) > 200
  )
    throw failure(400, 'VALIDATION_ERROR', '规格不能重复，合计不能超过200件');
  return items.sort((a, b) => a.skuId.localeCompare(b.skuId));
}
export class ConsumerCartService {
  constructor(readonly catalog: CatalogService) {}
  private async locked<T>(
    request: ApiRequest,
    work: (tx: Prisma.TransactionClient, cart: ConsumerCart) => Promise<T>,
  ) {
    const context = request.consumerContext!;
    return this.catalog.db.$transaction(async (tx) => {
      // Revalidate under shared locks so revocation/disabling cannot race an accepted write.
      const valid = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT u.id FROM consumer_users u JOIN consumer_sessions s ON s.user_id=u.id
  WHERE u.id=${context.userId}::uuid AND s.id=${context.sessionId}::uuid AND u.enabled AND s.revoked_at IS NULL
  AND s.expires_at>CURRENT_TIMESTAMP AND s.auth_version=u.auth_version FOR SHARE OF u,s`;
      if (!valid.length) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
      await tx.$executeRaw`INSERT INTO consumer_carts(user_id) VALUES(${context.userId}::uuid) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<
        Array<{ version: number }>
      >`SELECT version FROM consumer_carts WHERE user_id=${context.userId}::uuid FOR UPDATE`;
      const saved = await tx.consumerCartItem.findMany({
        where: { userId: context.userId },
        orderBy: { skuId: 'asc' },
        select: { skuId: true, quantity: true, selected: true, name: true, spec: true, unit: true },
      });
      return work(tx, { version: rows[0]!.version, items: saved });
    });
  }
  async read(request: ApiRequest) {
    return this.locked(request, async (_tx, cart) => cart);
  }
  private async save(
    tx: Prisma.TransactionClient,
    request: ApiRequest,
    current: ConsumerCart,
    items: ConsumerCartItem[],
    action: string,
  ): Promise<ConsumerCart> {
    if (
      items.length > 50 ||
      items.reduce((n, i) => n + i.quantity, 0) > 200 ||
      items.some((i) => i.quantity > 200)
    )
      throw failure(
        409,
        'CART_LIMIT_EXCEEDED',
        '购物车最多50种规格、合计200件；本次操作未保存，请调整后重试',
      );
    if (current.version >= 2147483646)
      throw failure(409, 'CART_VERSION_EXHAUSTED', '购物车版本需要维护');
    const userId = request.consumerContext!.userId;
    await tx.consumerCartItem.deleteMany({ where: { userId } });
    if (items.length)
      await tx.consumerCartItem.createMany({ data: items.map((i) => ({ ...i, userId })) });
    const version = current.version + 1;
    await tx.consumerCart.update({ where: { userId }, data: { version } });
    await tx.consumerCartAudit.create({
      data: { id: randomUUID(), userId, version, action, requestId: request.requestId },
    });
    return { version, items: items.sort((a, b) => a.skuId.localeCompare(b.skuId)) };
  }
  private assertVersion(value: unknown, current: ConsumerCart) {
    if (integer(value, 0, 2147483646) !== current.version)
      throw failure(409, 'CART_VERSION_CONFLICT', '购物车已在其他操作中更新，请刷新后重新操作');
  }
  async mutate(
    request: ApiRequest,
    action: 'ADD' | 'UPDATE' | 'REMOVE' | 'SELECT',
    body: unknown,
    id?: string,
  ) {
    const row = fields(
      body,
      action === 'ADD'
        ? ['version', 'skuId']
        : action === 'UPDATE'
          ? ['version', 'quantity', 'selected']
          : action === 'SELECT'
            ? ['version', 'skuIds', 'selected']
            : ['version'],
    );
    const skuId = action === 'ADD' ? uuid(row.skuId) : id ? uuid(id) : '';
    const quantity = action === 'UPDATE' ? integer(row.quantity, 1, 200) : 0;
    const checked = action === 'UPDATE' || action === 'SELECT' ? selected(row.selected) : false;
    const ids =
      action === 'SELECT'
        ? Array.isArray(row.skuIds) && row.skuIds.length <= 50
          ? row.skuIds.map(uuid)
          : null
        : [];
    if (ids === null) throw failure(400, 'VALIDATION_ERROR', '勾选项不正确');
    let sku;
    if (action === 'ADD') {
      const result = await this.catalog.catalog({
        limit: 20,
        keyword: '',
        categoryId: null,
        relatedToSkuId: skuId,
      });
      sku = result.items.find((i) => i.id === skuId);
      if (!sku || result.hasMore)
        throw failure(409, 'SKU_UNAVAILABLE', '商品资料已变化，请刷新后重试');
      if (sku.available < 1) throw failure(409, 'SKU_OUT_OF_STOCK', '该规格暂时缺货');
    }
    const added = sku;
    return this.locked(request, async (tx, current) => {
      this.assertVersion(row.version, current);
      const found = current.items.find((i) => i.skuId === skuId);
      let items = current.items;
      if (action === 'ADD')
        items = found
          ? items.map((i) =>
              i.skuId === skuId
                ? {
                    ...i,
                    quantity: i.quantity + 1,
                    name: added!.name,
                    spec: added!.spec,
                    unit: added!.unit,
                  }
                : i,
            )
          : [
              ...items,
              {
                skuId,
                quantity: 1,
                selected: true,
                name: added!.name,
                spec: added!.spec,
                unit: added!.unit,
              },
            ];
      else if (action === 'SELECT') {
        if (ids.some((id) => !items.some((i) => i.skuId === id)))
          throw failure(409, 'CART_VERSION_CONFLICT', '勾选项已变化，请刷新');
        items = items.map((i) => (ids.includes(i.skuId) ? { ...i, selected: checked } : i));
      } else {
        if (!found) throw failure(404, 'CART_ITEM_NOT_FOUND', '当前购物车中没有该商品');
        items =
          action === 'REMOVE'
            ? items.filter((i) => i.skuId !== skuId)
            : items.map((i) => (i.skuId === skuId ? { ...i, quantity, selected: checked } : i));
      }
      return this.save(tx, request, current, items, action);
    });
  }
  async merge(request: ApiRequest, body: unknown, key: string): Promise<CartMergeResult> {
    const row = fields(body, ['items']),
      items = cartItems(row.items),
      digest = tokenHash(JSON.stringify(items));
    return this.locked(request, async (tx, current) => {
      const userId = request.consumerContext!.userId;
      const previous = await tx.consumerCartMerge.findUnique({
        where: { userId_key: { userId, key } },
      });
      if (previous) {
        if (previous.digest !== digest)
          throw failure(
            409,
            'IDEMPOTENCY_CONFLICT',
            '此合并编号已用于另一份草稿，请保留原稿并核查',
          );
        return previous.result as unknown as CartMergeResult;
      }
      const combined = current.items.map((i) => ({ ...i }));
      for (const item of items) {
        const found = combined.find((i) => i.skuId === item.skuId);
        if (found) found.quantity += item.quantity;
        else combined.push({ ...item });
      }
      const cart = await this.save(tx, request, current, combined, 'MERGE');
      const checks: CartMergeResult['checks'] = [];
      for (const item of items) {
        let status: CartMergeResult['checks'][number]['status'] = 'unknown';
        try {
          const result = await this.catalog.catalog({
            limit: 20,
            keyword: '',
            categoryId: null,
            relatedToSkuId: item.skuId,
          });
          const sku = result.items.find((i) => i.id === item.skuId);
          status = result.hasMore
            ? 'unknown'
            : !sku || sku.available < 1
              ? 'unavailable'
              : sku.available < combined.find((i) => i.skuId === item.skuId)!.quantity
                ? 'excess'
                : 'available';
        } catch (e) {
          if (e instanceof HttpException && e.getStatus() === 404) status = 'unavailable';
        }
        checks.push({ skuId: item.skuId, status });
      }
      const result = { cart, checks };
      await tx.consumerCartMerge.create({
        data: { userId, key, digest, result: JSON.parse(JSON.stringify(result)) },
      });
      return result;
    });
  }
}
