import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import type {
  ExpressAddressInput,
  ExpressAddressBook,
  ConsumerAddressReceipt,
} from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, integer, str, uuid } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
function label(value: unknown, max: number, optional = false) {
  if (
    typeof value === 'string' &&
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw failure(400, 'VALIDATION_ERROR', '地址字段不能包含控制字符');
  if (optional && (value === undefined || (typeof value === 'string' && !value.trim()))) return '';
  return str(value, max);
}
export function addressInput(body: unknown): ExpressAddressInput & { version: number } {
  const row = fields(body, [
    'version',
    'province',
    'city',
    'district',
    'detailAddress',
    'contactName',
    'phone',
    'note',
    'isDefault',
  ]);
  const phone = label(row.phone, 21);
  if (!/^\+?[0-9]{6,20}$/.test(phone) || typeof row.isDefault !== 'boolean')
    throw failure(
      400,
      'VALIDATION_ERROR',
      '联系电话需6至20位数字，可带国际区号加号；默认标记须为布尔值',
    );
  return {
    version: integer(row.version, 0, 2147483646),
    province: label(row.province, 40),
    city: label(row.city, 40),
    district: label(row.district, 40),
    detailAddress: label(row.detailAddress, 200),
    contactName: label(row.contactName, 40),
    phone,
    note: label(row.note, 200, true),
    isDefault: row.isDefault,
  };
}
export class ConsumerExpressAddressService {
  constructor(
    readonly catalog: CatalogService,
    private readonly encryptionKey?: string,
  ) {}
  private key() {
    if (!this.encryptionKey) throw failure(503, 'ADDRESS_STORAGE_UNAVAILABLE', '地址服务尚未配置');
    return Buffer.from(this.encryptionKey, 'hex');
  }
  private encrypt(userId: string, id: string, value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(userId + ':' + id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }
  decryptSnapshot(userId: string, id: string, payload: string) {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw Error('Invalid encrypted address');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
    cipher.setAAD(Buffer.from(userId + ':' + id));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8'),
    ) as Pick<
      ExpressAddressInput,
      'province' | 'city' | 'district' | 'detailAddress' | 'contactName' | 'phone' | 'note'
    >;
  }
  private async locked<T>(
    request: ApiRequest,
    work: (tx: Prisma.TransactionClient, userId: string, version: number) => Promise<T>,
  ) {
    this.key();
    const context = request.consumerContext!;
    return this.catalog.db.$transaction(async (tx) => {
      const valid = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT u.id FROM consumer_users u JOIN consumer_sessions s ON s.user_id=u.id WHERE u.id=${context.userId}::uuid AND s.id=${context.sessionId}::uuid AND u.enabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version FOR SHARE OF u,s`;
      if (!valid.length) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
      await tx.$executeRaw`INSERT INTO consumer_express_address_books(user_id) VALUES(${context.userId}::uuid) ON CONFLICT DO NOTHING`;
      const rows = await tx.$queryRaw<
        Array<{ version: number }>
      >`SELECT version FROM consumer_express_address_books WHERE user_id=${context.userId}::uuid FOR UPDATE`;
      const result = await work(tx, context.userId, rows[0]!.version);
      const still = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM consumer_sessions WHERE id=${context.sessionId}::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
      if (!still.length) throw failure(401, 'SESSION_EXPIRED', '处理期间登录已过期，本次操作回滚');
      return result;
    });
  }
  async read(request: ApiRequest): Promise<ExpressAddressBook> {
    return this.locked(request, async (tx, userId, version) => {
      const rows = await tx.consumerExpressAddress.findMany({
        where: { userId, deleted: false },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
      });
      const policy = await tx.redemptionExpressPolicy.findUnique({
        where: {
          warehouseId: this.catalog.publicWarehouseId ?? '00000000-0000-0000-0000-000000000000',
        },
      });
      const items = rows.map((row) => {
        const data = this.decryptSnapshot(userId, row.id, row.payload!);
        return {
          id: row.id,
          isDefault: row.isDefault,
          ...data,
          available: !!policy?.enabled && policy.provinces.includes(data.province),
        };
      });
      return { version, items };
    });
  }
  async write(
    request: ApiRequest,
    key: string,
    action: 'CREATE' | 'UPDATE' | 'DEFAULT' | 'DELETE',
    body: unknown,
    addressId?: string,
  ): Promise<ConsumerAddressReceipt> {
    const input =
      action === 'CREATE' || action === 'UPDATE'
        ? addressInput(body)
        : { version: integer(fields(body, ['version']).version, 0, 2147483646) };
    const id = addressId ? uuid(addressId) : undefined;
    return this.locked(request, async (tx, userId, version) => {
      const digest = createHmac('sha256', this.key())
        .update(JSON.stringify({ action, id: id ?? null, input }))
        .digest('hex');
      const previous = await tx.consumerExpressAddressOperation.findUnique({
        where: { userId_key: { userId, key } },
      });
      if (previous) {
        if (previous.digest !== digest)
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原操作内容已改变，请先核实地址列表');
        return previous.result as unknown as ConsumerAddressReceipt;
      }
      const current = id
        ? await tx.consumerExpressAddress.findFirst({ where: { id, userId, deleted: false } })
        : null;
      if (action !== 'CREATE' && !current)
        throw failure(404, 'ADDRESS_NOT_FOUND', '未找到本人该收货地址');
      if (version !== input.version || version >= 2147483646)
        throw failure(409, 'ADDRESS_VERSION_CONFLICT', '地址已在其他操作中更新，请重新读取');
      const data = 'province' in input ? input : null;

      if (
        action === 'CREATE' &&
        (await tx.consumerExpressAddress.count({ where: { userId, deleted: false } })) >= 20
      )
        throw failure(409, 'ADDRESS_LIMIT', '最多保存20个地址，请先整理已有地址');
      const savedId = current?.id ?? randomUUID();
      if (action === 'DEFAULT' || data?.isDefault)
        await tx.consumerExpressAddress.updateMany({
          where: { userId, isDefault: true, deleted: false },
          data: { isDefault: false },
        });
      if (data) {
        const payload = this.encrypt(userId, savedId, {
          province: data.province,
          city: data.city,
          district: data.district,
          detailAddress: data.detailAddress,
          contactName: data.contactName,
          phone: data.phone,
          note: data.note,
        });
        const value = {
          isDefault: data.isDefault,
          payload,
        };
        if (action === 'CREATE')
          await tx.consumerExpressAddress.create({ data: { id: savedId, userId, ...value } });
        else await tx.consumerExpressAddress.update({ where: { id: savedId }, data: value });
      } else
        await tx.consumerExpressAddress.update({
          where: { id: savedId },
          data:
            action === 'DEFAULT'
              ? { isDefault: true }
              : { deleted: true, isDefault: false, payload: null },
        });
      const result = { id: savedId, version: version + 1 };
      await tx.consumerExpressAddressBook.update({
        where: { userId },
        data: { version: version + 1 },
      });
      await tx.consumerExpressAddressAudit.create({
        data: {
          id: randomUUID(),
          userId,
          addressId: savedId,
          version: version + 1,
          action,
          requestId: request.requestId,
        },
      });
      await tx.consumerExpressAddressOperation.create({ data: { userId, key, digest, result } });
      return result;
    });
  }
}
