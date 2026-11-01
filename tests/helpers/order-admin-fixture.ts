import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../../packages/database/dist/index.js';
import { checkoutFixture } from './checkout-fixture.ts';
export async function orderAdminFixture(options: { holdSeconds?: number } = {}) {
  const f = await checkoutFixture({ orders: true, ...options });
  try {
    await f.runtime.db.checkoutPolicy.create({
      data: { warehouseId: f.warehouseId, open: true, deliveryFeeCents: 300, minGoodsCents: 0 },
    });
    const password = randomBytes(20).toString('hex'),
      hash = await hashPassword(password),
      extraIds = [randomUUID(), randomUUID()];
    for (const [i, id] of extraIds.entries())
      await f.runtime.db.staff.create({
        data: {
          id,
          loginName: 'order-test-' + i,
          displayName: '订单隔离验收员',
          passwordHash: hash,
          roles: { create: { roleCode: i === 0 ? 'SUPER_ADMIN' : 'RIDER' } },
          warehouses: { create: { warehouseId: f.warehouseId } },
        },
      });
    async function login(loginName: string, pass: string) {
      const r = await fetch(f.base + '/api/v1/staff/auth/session', {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName, password: pass }),
      });
      if (r.status !== 200) throw Error('Fixture staff login failed');
      return r.headers.get('set-cookie')!.split(';')[0]!;
    }
    const cookies = await Promise.all(
      ['quote-ui-0', 'quote-ui-1', 'quote-ui-2'].map((n) => login(n, f.password)),
    );
    const extraCookies = await Promise.all([0, 1].map((i) => login('order-test-' + i, password)));
    async function staff(path: string, cookie = cookies[0]!, method = 'GET') {
      const r = await fetch(f.base + '/api/v1' + path, {
        method,
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:5188' },
      });
      return { status: r.status, ...(await r.json()) };
    }
    async function create(token = f.identity.token) {
      const book = await f.call('/consumer/addresses', undefined, token),
        cart = await f.call('/consumer/cart', undefined, token);
      const q = await f.call(
        '/consumer/checkout/quotes',
        {
          addressId: book.data.items[0].id,
          addressVersion: book.data.version,
          cartVersion: cart.data.version,
        },
        token,
      );
      if (q.status !== 200) throw Error('Fixture quote failed');
      const order = await f.call(
        '/consumer/orders',
        { quoteId: q.data.id, note: '合成订单私密备注' },
        token,
      );
      if (order.status !== 200) throw Error('Fixture order failed');
      return order.data.id as string;
    }
    async function secondCustomer() {
      const login = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, ''),
        token = login.data.token as string;
      const address = await f.call(
        '/consumer/addresses',
        {
          version: 0,
          areaId: f.areaId,
          buildingId: f.buildingId,
          room: '合成B门牌',
          unit: '',
          contactName: '合成B联系人',
          phone: '00000000001',
          note: '',
          isDefault: true,
        },
        token,
      );
      if (address.status !== 200) throw Error('Fixture second address failed');
      for (const [version, skuId] of [f.catalog.skuIds[0], f.catalog.skuIds[1]].entries())
        if ((await f.call('/consumer/cart/items', { version, skuId }, token)).status !== 200)
          throw Error('Fixture second cart failed');
      return token;
    }
    return { ...f, cookies, extraCookies, staff, create, secondCustomer };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
