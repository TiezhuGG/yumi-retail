import { randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { fields, integer, str } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
function name(value: unknown, max: number) {
  const text = str(value, max).replace(/\s+/g, ' ');
  if (
    Array.from(String(value)).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw failure(400, 'VALIDATION_ERROR', '名称不能包含换行或控制字符');
  return text;
}
function enabled(value: unknown) {
  if (typeof value !== 'boolean') throw failure(400, 'VALIDATION_ERROR', '启用状态必须为布尔值');
  return value;
}
const include = {
  warehouse: { select: { id: true, name: true } },
  buildings: {
    orderBy: { nameKey: 'asc' as const },
    select: { id: true, name: true, enabled: true },
  },
};
export class ServiceAreaService {
  constructor(readonly catalog: CatalogService) {}
  private warehouseId() {
    const id = this.catalog.publicWarehouseId;
    if (!id) throw failure(503, 'STORE_UNAVAILABLE', '尚未配置经营仓库');
    return id;
  }
  private async scope(tx: Prisma.TransactionClient, request: ApiRequest) {
    const id = this.warehouseId();
    await this.catalog.warehouse(tx, request, id);
    return id;
  }
  async read(request: ApiRequest) {
    return this.catalog.db.$transaction(async (tx) => {
      const warehouseId = await this.scope(tx, request);
      await tx.$queryRaw`SELECT id FROM service_areas WHERE warehouse_id=${warehouseId}::uuid FOR SHARE`;
      const area = await tx.serviceArea.findUnique({ where: { warehouseId }, include });
      return { area: area ? this.dto(area) : null };
    });
  }
  private dto(area: {
    id: string;
    name: string;
    enabled: boolean;
    version: number;
    warehouse: { id: string; name: string };
    buildings: Array<{ id: string; name: string; enabled: boolean }>;
  }) {
    return {
      id: area.id,
      name: area.name,
      enabled: area.enabled,
      version: area.version,
      warehouse: area.warehouse,
      buildings: area.buildings,
    };
  }
  async write(
    request: ApiRequest,
    key: string,
    action: 'CREATE' | 'UPDATE' | 'BUILDING_CREATE' | 'BUILDING_UPDATE',
    body: unknown,
    buildingId?: string,
  ) {
    const row = fields(
      body,
      action === 'CREATE'
        ? ['name']
        : action === 'BUILDING_CREATE'
          ? ['version', 'name']
          : ['version', 'name', 'enabled'],
    );
    const title = name(row.name, action.startsWith('BUILDING') ? 80 : 100);
    const expected = action === 'CREATE' ? null : integer(row.version, 0, 2147483646);
    const active =
      action === 'UPDATE' || action === 'BUILDING_UPDATE' ? enabled(row.enabled) : false;
    const warehouseId = this.warehouseId();
    // Authorize even historical replays against current staff warehouse scope.
    await this.catalog.warehouse(this.catalog.db, request, warehouseId);
    return this.catalog.write(
      request,
      'SERVICE_AREA_' + action,
      buildingId ?? warehouseId,
      key,
      { version: expected, name: title, enabled: active },
      async (tx) => {
        await this.scope(tx, request);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('yumi-single-service-area',0))::text`;
        await tx.$queryRaw`SELECT id FROM service_areas WHERE warehouse_id=${warehouseId}::uuid FOR UPDATE`;
        const area = await tx.serviceArea.findUnique({ where: { warehouseId } });
        if (action === 'CREATE') {
          if (await tx.serviceArea.count())
            throw failure(409, 'SERVICE_AREA_EXISTS', '首版只支持一个服务小区，请编辑已有配置');
          const saved = await tx.serviceArea.create({
            data: { id: randomUUID(), warehouseId, name: title },
            include,
          });
          await this.catalog.audit(
            tx,
            request,
            'SERVICE_AREA_CREATE',
            saved.id,
            warehouseId,
            null,
            { name: title, enabled: false },
          );
          return { area: this.dto(saved) };
        }
        if (!area) throw failure(404, 'SERVICE_AREA_NOT_FOUND', '尚未建立服务小区');
        if (area.version !== expected)
          throw failure(409, 'VERSION_CONFLICT', '服务范围已更新，请刷新后重新操作');
        if (area.version >= 2147483646) throw failure(409, 'VERSION_CONFLICT', '版本需要维护');
        if (action === 'UPDATE')
          await tx.serviceArea.update({
            where: { id: area.id },
            data: { name: title, enabled: active, version: { increment: 1 } },
          });
        else {
          const keys = await tx.$queryRaw<Array<{ key: string }>>`SELECT lower(${title}) AS key`;
          const nameKey = keys[0]!.key;
          if (
            await tx.serviceBuilding.findFirst({
              where: {
                areaId: area.id,
                nameKey,
                ...(buildingId ? { id: { not: buildingId } } : {}),
              },
            })
          )
            throw failure(409, 'BUILDING_EXISTS', '当前小区已有同名楼栋');
          if (action === 'BUILDING_CREATE') {
            if ((await tx.serviceBuilding.count({ where: { areaId: area.id } })) >= 200)
              throw failure(409, 'BUILDING_LIMIT', '最多维护200栋楼，请先核对现有配置');
            await tx.serviceBuilding.create({
              data: { id: randomUUID(), areaId: area.id, name: title, nameKey },
            });
          } else {
            const existing = await tx.serviceBuilding.findFirst({
              where: { id: buildingId, areaId: area.id },
            });
            if (!existing) throw failure(404, 'BUILDING_NOT_FOUND', '当前小区没有该楼栋');
            await tx.serviceBuilding.update({
              where: { id: existing.id },
              data: { name: title, nameKey, enabled: active },
            });
          }
          await tx.serviceArea.update({
            where: { id: area.id },
            data: { version: { increment: 1 } },
          });
        }
        await this.catalog.audit(
          tx,
          request,
          'SERVICE_AREA_' + action,
          buildingId ?? area.id,
          warehouseId,
          null,
          { name: title, enabled: active, version: area.version + 1 },
        );
        return {
          area: this.dto(
            await tx.serviceArea.findUniqueOrThrow({ where: { id: area.id }, include }),
          ),
        };
      },
    );
  }
  private async publicArea(id?: string) {
    const warehouseId = this.catalog.publicWarehouseId;
    if (!warehouseId) return null;
    return this.catalog.db.serviceArea.findFirst({
      where: { ...(id ? { id } : {}), warehouseId, enabled: true, warehouse: { enabled: true } },
      select: { id: true, name: true, version: true },
    });
  }
  async publicList() {
    const area = await this.publicArea();
    return { items: area ? [area] : [] };
  }
  async buildings(id: string) {
    const warehouseId = this.catalog.publicWarehouseId;
    if (!warehouseId) throw failure(404, 'SERVICE_AREA_UNAVAILABLE', '服务范围尚未开放或已暂停');
    return this.catalog.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; name: string; version: number }>
      >`SELECT a.id,a.name,a.version FROM service_areas a JOIN warehouses w ON w.id=a.warehouse_id WHERE a.id=${id}::uuid AND a.warehouse_id=${warehouseId}::uuid AND a.enabled AND w.enabled FOR SHARE OF a,w`;
      const area = rows[0];
      if (!area) throw failure(404, 'SERVICE_AREA_UNAVAILABLE', '服务范围尚未开放或已暂停');
      const items = await tx.serviceBuilding.findMany({
        where: { areaId: area.id, enabled: true },
        select: { id: true, name: true },
        orderBy: { nameKey: 'asc' },
      });
      return { area, items };
    });
  }
  async building(areaId: string, id: string) {
    const result = await this.buildings(areaId);
    const building = result.items.find((b) => b.id === id);
    if (!building) throw failure(404, 'BUILDING_UNAVAILABLE', '该楼栋不在当前有效服务范围');
    return { area: result.area, building };
  }
}
