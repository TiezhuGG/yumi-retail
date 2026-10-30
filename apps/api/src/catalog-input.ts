import { failure, header } from './http.js';
import type { ApiRequest } from './http.js';

export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw failure(400, 'VALIDATION_ERROR', '包含无效字段');
  return value as Record<string, unknown>;
}
export function str(value: unknown, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw failure(400, 'VALIDATION_ERROR', '文本字段为空或过长');
  return value.trim();
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw failure(400, 'VALIDATION_ERROR', '金额和数量必须为范围内的整数');
  return value;
}
export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw failure(400, 'VALIDATION_ERROR', '编号格式无效');
  return value.toLowerCase();
}
export function key(request: ApiRequest): string {
  return uuid(header(request, 'idempotency-key'));
}
export function version(value: unknown): number {
  return integer(fields(value, ['version']).version, 0, 2147483646);
}
export function instant(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw failure(400, 'VALIDATION_ERROR', '时间须为有效的UTC ISO时间');
  const normalized = new Date(value).toISOString();
  if (normalized !== value && normalized.replace('.000Z', 'Z') !== value)
    throw failure(400, 'VALIDATION_ERROR', '日期不存在');
  return normalized;
}
export interface ProductInput {
  categoryId: string;
  name: string;
  description: string;
  skus: { code: string; spec: string; unit: string; priceCents: number; expiryManaged: boolean }[];
}
export function productInput(value: unknown): ProductInput {
  const b = fields(value, ['categoryId', 'name', 'description', 'skus']);
  if (!Array.isArray(b.skus) || b.skus.length < 1 || b.skus.length > 20)
    throw failure(400, 'VALIDATION_ERROR', '每个商品需1–20个规格');
  const skus = b.skus.map((value) => {
    const row = fields(value, ['code', 'spec', 'unit', 'priceCents', 'expiryManaged']);
    const code = str(row.code, 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code) || typeof row.expiryManaged !== 'boolean')
      throw failure(400, 'VALIDATION_ERROR', '规格编码或效期标识无效');
    return {
      code,
      spec: str(row.spec, 100),
      unit: str(row.unit, 16),
      priceCents: integer(row.priceCents, 1, 100000000),
      expiryManaged: row.expiryManaged,
    };
  });
  if (new Set(skus.map((s) => s.code)).size !== skus.length)
    throw failure(400, 'VALIDATION_ERROR', '规格编码重复');
  return {
    categoryId: uuid(b.categoryId),
    name: str(b.name, 120),
    description: str(b.description, 2000, true),
    skus,
  };
}
export interface ProductDetailsInput {
  version: number;
  categoryId: string;
  name: string;
  description: string;
}
export function productDetailsInput(value: unknown): ProductDetailsInput {
  const b = fields(value, ['version', 'categoryId', 'name', 'description']);
  if (typeof b.description !== 'string' || b.description.trim().length > 2000)
    throw failure(400, 'VALIDATION_ERROR', '商品说明须为不超过2000字的文本');
  return {
    version: integer(b.version, 0, 2147483646),
    categoryId: uuid(b.categoryId),
    name: str(b.name, 120),
    description: b.description.trim(),
  };
}
export function receiptInput(value: unknown) {
  const b = fields(value, ['sourceRef', 'lines']);
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 50)
    throw failure(400, 'VALIDATION_ERROR', '收货单需1–50行');
  const lines = b.lines
    .map((value) => {
      const row = fields(value, [
        'skuId',
        'batchNo',
        'quantity',
        'unitCostCents',
        'producedAt',
        'expiresAt',
      ]);
      return {
        skuId: uuid(row.skuId),
        batchNo: str(row.batchNo, 64),
        quantity: integer(row.quantity, 1, 100000),
        unitCostCents: integer(row.unitCostCents, 0, 100000000),
        producedAt: instant(row.producedAt),
        expiresAt: instant(row.expiresAt),
      };
    })
    .sort((a, b) => a.skuId.localeCompare(b.skuId));
  if (new Set(lines.map((line) => line.skuId)).size !== lines.length)
    throw failure(400, 'VALIDATION_ERROR', '本轮每单每个SKU只允许一个批次');
  return { sourceRef: str(b.sourceRef, 100), lines };
}
export type ReceiptInput = ReturnType<typeof receiptInput>;
export function page(query: Record<string, unknown>) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (typeof query.limit !== 'undefined' && typeof query.limit !== 'string')
    throw failure(400, 'VALIDATION_ERROR', '分页参数无效');
  integer(limit, 1, 50);
  return { limit, cursor: query.cursor === undefined ? undefined : uuid(query.cursor) };
}

export function skuBarcodeInput(value: unknown) {
  const b = fields(value, ['version', 'barcode']);
  if (b.barcode !== null && typeof b.barcode !== 'string')
    throw failure(400, 'VALIDATION_ERROR', '条码须为文本或null');
  const barcode = typeof b.barcode === 'string' ? b.barcode.trim() || null : null;
  if (barcode !== null && !/^[0-9]{1,64}$/.test(barcode))
    throw failure(400, 'VALIDATION_ERROR', '条码须为1–64位数字，空白表示清空');
  return { version: integer(b.version, 0, 2147483646), barcode };
}
