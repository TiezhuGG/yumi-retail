import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './order-admin-fixture.ts';
export async function pickingFixture(options: { pickingLab?: boolean } = {}) {
  const f = await orderAdminFixture({ notificationLab: true, ...options });
  try {
    const pickerId = randomUUID(),
      source = await f.runtime.db.staff.findUniqueOrThrow({ where: { id: f.staffIds[0] } });
    await f.runtime.db.staff.create({
      data: {
        id: pickerId,
        loginName: 'picking-test',
        displayName: '隔离拣货验收员',
        passwordHash: source.passwordHash,
        roles: { create: { roleCode: 'PICKER' } },
        warehouses: { create: { warehouseId: f.warehouseId } },
      },
    });
    const login = await fetch(f.base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: 'picking-test', password: f.password }),
    });
    if (login.status !== 200) throw Error('Picker fixture login failed');
    return { ...f, pickerId, pickerCookie: login.headers.get('set-cookie')!.split(';')[0]! };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
