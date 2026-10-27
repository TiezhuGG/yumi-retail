import { createDatabase, hashPassword } from '../src/index.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Development seed is disabled in production.');
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/yumi_dev')
  throw new Error('Seed only permits the isolated local development database.');
const db = createDatabase(url.toString());
try {
  const id = '00000000-0000-4000-8000-000000000001';
  await db.validationStock.upsert({
    where: { id },
    create: { id, label: 'S0 development fixture (not a real saleable SKU)', onHand: 10 },
    update: {},
  });
  console.log('S0 development fixture ready; existing stock quantities preserved.');
  const warehouseId = '00000000-0000-4000-8000-000000000002';
  await db.warehouse.upsert({
    where: { id: warehouseId },
    create: { id: warehouseId, code: 'DEMO-01', name: '演示仓库' },
    update: {},
  });
  const accounts = [
    ['00000000-0000-4000-8000-000000000003', 'ADMIN', 'SUPER_ADMIN', '本地管理员'],
    ['00000000-0000-4000-8000-000000000004', 'WAREHOUSE', 'WAREHOUSE_MANAGER', '本地仓管'],
    ['00000000-0000-4000-8000-000000000005', 'RIDER', 'RIDER', '本地骑手'],
  ];
  for (const [staffId, key, role, displayName] of accounts) {
    if (!staffId || !key || !role || !displayName) throw new Error('Invalid local fixture.');
    const loginName = process.env[`LOCAL_${key}_LOGIN`];
    const password = process.env[`LOCAL_${key}_PASSWORD`];
    if (!loginName || !password) throw new Error('Run setup:local before staff seed.');
    if (await db.staff.findUnique({ where: { id: staffId } })) continue;
    await db.staff.create({
      data: {
        id: staffId,
        loginName,
        displayName,
        passwordHash: await hashPassword(password),
        roles: { create: { roleCode: role } },
        warehouses: { create: { warehouseId } },
      },
    });
  }
  console.log(
    'Local warehouse and staff fixtures ready; existing accounts and passwords preserved.',
  );
} finally {
  await db.$disconnect();
}
