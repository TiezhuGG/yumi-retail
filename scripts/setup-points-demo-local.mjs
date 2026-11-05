// Synthetic local demo only. Never opens formal/production exchange or cash payment.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { assertLocalRewardSeed } from './seed-rewards-local.mjs';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { hashPassword } from '../packages/database/dist/index.js';
const url = assertLocalRewardSeed(process.env, process.argv.slice(2));
if (
  (process.env.POINTS_EXPRESS_MODE !== undefined && process.env.POINTS_EXPRESS_MODE !== 'off') ||
  process.env.WECHAT_LOGIN_ENABLED === '1'
)
  throw Error('Formal exchange/WeChat must remain disabled.');
const env = readFileSync('.env', 'utf8');
if (!env.includes('DATABASE_URL=' + process.env.DATABASE_URL))
  throw Error('Run with the workspace .env');
const runtime = await createApplication(url, {
  config: applicationConfig({
    ...process.env,
    CONSUMER_DEV_LOGIN_ENABLED: '1',
    REDEMPTION_DEV_SUBMIT_ENABLED: '1',
    REDEMPTION_PICKING_DEV_ENABLED: '1',
  }),
});
const key = (s) => {
  const h = createHash('sha256')
    .update('points-local-demo-v1:' + s)
    .digest('hex');
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-4' +
    h.slice(13, 16) +
    '-8' +
    h.slice(17, 20) +
    '-' +
    h.slice(20, 32)
  );
};
try {
  await runtime.app.listen(0, '127.0.0.1');
  const base = (await runtime.app.getUrl()) + '/api/v1';
  async function call(path, body, headers = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (r.status !== 200) throw Error(path + ': ' + r.status + ' ' + j.error?.code);
    return { r, data: j.data };
  }
  async function staff(loginName, password) {
    const { r } = await call('/staff/auth/session', { loginName, password });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const { data } = await call('/staff/me', undefined, { Cookie: cookie });
    return { Cookie: cookie, 'X-CSRF-Token': data.csrfToken };
  }
  const admin = await staff(process.env.LOCAL_ADMIN_LOGIN, process.env.LOCAL_ADMIN_PASSWORD);
  const wh = process.env.PUBLIC_WAREHOUSE_ID;
  const shipping = await runtime.db.redemptionExpressPolicy.findUnique({
    where: { warehouseId: wh },
  });
  if (!shipping)
    await call(
      '/admin/redemption-express-policy/update',
      {
        version: 0,
        enabled: true,
        provinces: ['浙江省'],
        shippingFeeMode: 'SENDER_PAID',
        reason: '本地合成兑换示例；经营规则待上线前确认',
      },
      { ...admin, 'Idempotency-Key': key('express-policy') },
    );
  const identities = [];
  for (const profile of ['customer-a', 'customer-b']) {
    const { data } = await call(
      '/consumer/auth/dev-session',
      { profile },
      { 'X-Yumi-Dev-Login': '1' },
    );
    identities.push({ profile, ...data });
  }
  const missing = [];
  for (const i of identities) {
    const grant = await runtime.db
      .$queryRaw`SELECT id,status FROM points_grants WHERE reference=${'LOCAL-DEMO-5000:' + i.user.id}`;
    if (!grant.length) missing.push(i);
    else
      assert.equal(
        grant[0].status,
        'APPROVED',
        'Existing synthetic grant must be reviewed; never grant twice',
      );
  }
  if (missing.length) {
    const policies = await runtime.db
      .$queryRaw`SELECT version FROM points_grant_policies WHERE warehouse_id=${wh}::uuid`;
    if (policies.length)
      throw Error(
        'Existing grant policy preserved; use the admin grant workflow for remaining demo users.',
      );
    const password = randomBytes(32).toString('hex'),
      id = randomUUID();
    await runtime.db.staff.create({
      data: {
        id,
        loginName: 'local-demo-requester-' + id,
        displayName: '本地合成积分申请员',
        passwordHash: await hashPassword(password),
        roles: { create: { roleCode: 'OPERATIONS' } },
        warehouses: { create: { warehouseId: wh } },
      },
    });
    try {
      const requester = await staff('local-demo-requester-' + id, password);
      await call(
        '/admin/points/grants/store/policy',
        {
          version: 0,
          enabled: true,
          singleLimit: '5000',
          dailyLimit: '10000',
          reason: '仅为两个隔离开发顾客准备演示积分',
        },
        { ...admin, 'Idempotency-Key': key('grant-policy') },
      );
      for (const i of missing) {
        const { data: g } = await call(
          '/admin/points/grants/store/create',
          {
            userId: i.user.id,
            amount: '5000',
            reference: 'LOCAL-DEMO-5000:' + i.user.id,
            reason: '本地合成演示积分，无现金价值；不向真实顾客发放',
          },
          { ...requester, 'Idempotency-Key': key(i.user.id + ':grant') },
        );
        await call(
          '/admin/points/grants/' + g.id + '/approve',
          { version: 0, reason: '核验隔离开发身份、合成凭据；经营参数待确认' },
          { ...admin, 'Idempotency-Key': key(i.user.id + ':approve') },
        );
      }
    } finally {
      await runtime.db.staff.update({
        where: { id },
        data: { enabled: false, authVersion: { increment: 1 } },
      });
      await runtime.db.staffSession.updateMany({
        where: { staffId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await call(
      '/admin/points/grants/store/policy',
      {
        version: 1,
        enabled: false,
        singleLimit: '5000',
        dailyLimit: '10000',
        reason: '演示额度准备完毕，关闭继续发放',
      },
      { ...admin, 'Idempotency-Key': key('grant-close') },
    );
  }
  for (const i of identities) {
    const h = {
      Authorization: 'Bearer ' + i.token,
      'Idempotency-Key': key(i.user.id + ':address'),
    };
    const { data: book } = await call('/consumer/express-addresses', undefined, h);
    if (!book.items.length)
      await call(
        '/consumer/express-addresses',
        {
          version: book.version,
          province: '浙江省',
          city: '杭州市',
          district: '西湖区',
          detailAddress: '本地演示地址1号（合成数据，请勿寄送）',
          contactName: '合成演示顾客',
          phone: '00000000000',
          note: '仅本地兑换演示，不代表真实收件人',
          isDefault: true,
        },
        h,
      );
    await call('/consumer/auth/logout', {}, h);
  }
  await call('/staff/auth/logout', {}, admin);
  mkdirSync('.local/backups', { recursive: true });
  const backup = '.local/backups/before-points-demo.env';
  if (!existsSync(backup)) writeFileSync(backup, env, { mode: 0o600 });
  let next = env;
  for (const name of [
    'CONSUMER_DEV_LOGIN_ENABLED',
    'REDEMPTION_DEV_SUBMIT_ENABLED',
    'REDEMPTION_PICKING_DEV_ENABLED',
  ]) {
    const re = new RegExp('^' + name + '=.*$', 'm');
    next = re.test(next) ? next.replace(re, name + '=1') : next + '\n' + name + '=1\n';
  }
  writeFileSync('.env', next, { mode: 0o600 });
  chmodSync('.env', 0o600);
  console.log(
    JSON.stringify({
      localOnly: true,
      identities: 2,
      newSyntheticGrants: missing.length,
      pointsPerUser: '5000',
      cashPayment: 'disabled',
      formalExchange: 'off',
      grantPolicy: 'closed',
      message:
        'Restart local API; build local mini with TARO_APP_CONSUMER_DEV_LOGIN=1. Synthetic addresses must never receive real shipments.',
    }),
  );
} finally {
  await runtime.close();
}
