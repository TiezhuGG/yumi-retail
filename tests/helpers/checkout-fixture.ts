// Synthetic disposable-schema checkout fixture. Does not configure real operating rules.
import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword } from '../../packages/database/dist/index.js';
import { addressFixture } from './address-fixture.ts';
import { seedCartCatalog } from './cart-catalog.ts';
export async function checkoutFixture(
  options: {
    orders?: boolean;
    holdSeconds?: number;
    pickingLab?: boolean;
    notificationLab?: boolean;
  } = {},
) {
  const fixture = await addressFixture(options);
  try {
    const { runtime, base, identity, warehouseId, areaId, buildingId } = fixture;
    const catalog = await seedCartCatalog(runtime, warehouseId, true),
      password = randomBytes(20).toString('hex'),
      passwordHash = await hashPassword(password);
    const staffIds = [randomUUID(), randomUUID(), randomUUID()];
    const other = await runtime.db.warehouse.create({
      data: { id: randomUUID(), code: 'QUOTE-OTHER', name: '其他测试仓' },
    });
    for (const [i, id] of staffIds.entries())
      await runtime.db.staff.create({
        data: {
          id,
          loginName: 'quote-ui-' + i,
          displayName: '报价隔离验收员',
          passwordHash,
          roles: { create: { roleCode: i === 1 ? 'WAREHOUSE_MANAGER' : 'OPERATIONS' } },
          warehouses: { create: { warehouseId: i === 2 ? other.id : warehouseId } },
        },
      });
    const call = async (
      path: string,
      body?: unknown,
      token = identity.token,
      key = randomUUID(),
    ) => {
      const r = await fetch(base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Idempotency-Key': key,
          'X-Yumi-Dev-Login': '1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: (await r.json()).data };
    };
    const address = await call('/consumer/addresses', {
      version: 0,
      areaId,
      buildingId,
      unit: '',
      room: '合成门牌101',
      contactName: '合成验收联系人',
      phone: '00000000000',
      note: '',
      isDefault: true,
    });
    if (address.status !== 200) throw Error('Fixture address failed');
    for (const [i, skuId] of [catalog.skuIds[0], catalog.skuIds[0], catalog.skuIds[1]].entries()) {
      const r = await call('/consumer/cart/items', { version: i, skuId });
      if (r.status !== 200) throw Error('Fixture cart failed');
    }
    return { ...fixture, catalog, password, staffIds, addressId: address.data.id, call };
  } catch (e) {
    await fixture.cleanup();
    throw e;
  }
}
