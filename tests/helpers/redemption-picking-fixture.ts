// Disposable schema and synthetic staff only; orders are created through the actual redemption API.
import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword } from '../../packages/database/dist/index.js';
import type { RedemptionPickingPage, StaffProfile } from '../../packages/contracts/src/index.ts';
import { redemptionFixture } from './redemption-fixture.ts';
export async function redemptionPickingFixture(enabled = true) {
  const f = await redemptionFixture({ picking: enabled });
  try {
    const prefix = '/warehouse/warehouses/' + f.warehouseId + '/redemption-picking';
    async function order() {
      const q = await f.call('/consumer/redemption-quotes', f.input);
      if (q.status !== 200) throw Error('Picking quote fixture failed');
      const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
      if (o.status !== 200) throw Error('Picking order fixture failed');
      return o.data.id;
    }
    async function workerActor(role: string = 'PICKER', warehouse: string = f.warehouseId) {
      const id = randomUUID(),
        loginName = 'picking-' + id,
        password = randomBytes(24).toString('hex');
      await f.runtime.db.staff.create({
        data: {
          id,
          loginName,
          displayName: role === 'PICKER' ? '合成拣货员' : '合成其他员工',
          passwordHash: await hashPassword(password),
          roles: { create: { roleCode: role } },
          warehouses: { create: { warehouseId: warehouse } },
        },
      });
      const login = await fetch(f.base + '/api/v1/staff/auth/session', {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName, password }),
      });
      if (login.status !== 200) throw Error('Picking staff login failed');
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: cookie } }),
        profile = ((await me.json()) as { data: StaffProfile }).data;
      return { id, cookie, csrf: profile.csrfToken, profile };
    }
    async function read(id?: string) {
      const r = await fetch(f.base + '/api/v1' + prefix + (id ? '/' + id : ''), {
        headers: { Cookie: f.cookie },
      });
      return { status: r.status, ...(await r.json()) } as {
        status: number;
        data: RedemptionPickingPage;
        error?: { code: string };
      };
    }
    return { ...f, prefix, order, workerActor, read };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
