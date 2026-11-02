// Synthetic data in a disposable local PostgreSQL schema only.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hashPassword } from '../../packages/database/dist/index.js';
import { addressFixture } from './address-fixture.ts';
export async function pointsFixture(
  options: { redemptions?: boolean; orders?: boolean; redemptionPicking?: boolean } = {},
) {
  const f = await addressFixture(options);
  try {
    const db = f.runtime.db,
      staffId = randomUUID(),
      password = randomBytes(24).toString('hex');
    await db.staff.create({
      data: {
        id: staffId,
        loginName: 'points-ui',
        displayName: '合成积分验收员',
        passwordHash: await hashPassword(password),
        roles: { create: { roleCode: 'SUPER_ADMIN' } },
        warehouses: { create: { warehouseId: f.warehouseId } },
      },
    });
    const response = await fetch(f.base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: 'points-ui', password }),
    });
    if (response.status !== 200) throw Error('Fixture staff login failed');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const second = await fetch(f.base + '/api/v1/consumer/auth/dev-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
      body: JSON.stringify({ profile: 'customer-b' }),
    });
    const { data: identityB } = await second.json();
    await db.consumerUser.update({
      where: { id: f.identity.user.id },
      data: { displayName: '合成积分顾客 A' },
    });
    async function seed() {
      // Test-only scale fixture: production development identities remain limited to A/B.
      const scopes = await db.$queryRaw<
        Array<{ schema: string }>
      >`SELECT current_schema() AS schema`;
      if (!scopes[0]?.schema.startsWith('address_ui_')) throw Error('Temporary UI schema required');
      await db.$executeRawUnsafe(
        'ALTER TABLE consumer_users DROP CONSTRAINT consumer_users_subject_check',
      );
      await db.consumerUser.createMany({
        data: Array.from({ length: 23 }, (_, i) => ({
          id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          provider: 'DEVELOPMENT',
          subject: createHash('sha256')
            .update('points-ui-' + i)
            .digest('hex'),
          displayName: '合成账户 ' + String(i + 1).padStart(2, '0'),
        })),
      });
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO points_accounts(user_id,balance) VALUES(${f.identity.user.id}::uuid,250)`;
        for (let i = 1; i <= 25; i++)
          await tx.$executeRaw`INSERT INTO points_ledger(id,user_id,delta,action_key,reason,actor_id,created_at) VALUES(${`20000000-0000-4000-8000-${String(i).padStart(12, '0')}`}::uuid,${f.identity.user.id}::uuid,10,${'ui-' + i},${'合成验证流水 ' + String(i).padStart(2, '0')} ,${staffId}::uuid,'2026-11-02T02:30:00Z')`;
      });
    }
    async function reviewer() {
      const id = randomUUID();
      await db.staff.create({
        data: {
          id,
          loginName: 'points-reviewer',
          displayName: '合成独立审批员',
          passwordHash: await hashPassword(password),
          roles: { create: { roleCode: 'SUPER_ADMIN' } },
          warehouses: { create: { warehouseId: f.warehouseId } },
        },
      });
      const r = await fetch(f.base + '/api/v1/staff/auth/session', {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName: 'points-reviewer', password }),
      });
      if (r.status !== 200) throw Error('Reviewer login failed');
      return r.headers.get('set-cookie')!.split(';')[0]!;
    }
    return { ...f, cookie, identityB, seed, reviewer };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
