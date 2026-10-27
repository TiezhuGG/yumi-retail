export interface HealthResponse {
  data: { status: 'ok'; service: 'api'; database?: 'connected' };
  requestId: string;
}

// Extend with generated OpenAPI contracts as business endpoints are implemented.
export const applicationStage = 'S1' as const;

export interface StaffProfile {
  id: string;
  loginName: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  warehouseIds: string[];
  csrfToken: string;
}
export interface WarehouseSummary {
  id: string;
  code: string;
  name: string;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
}
export interface Sku {
  id: string;
  productId: string;
  code: string;
  spec: string;
  unit: string;
  priceCents: number;
  expiryManaged: boolean;
  enabled: boolean;
}
export interface Product {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  status: string;
  version: number;
  skus: Sku[];
}
export interface ReceiptLine {
  id: string;
  skuId: string;
  batchNo: string;
  quantity: number;
  unitCostCents: number;
  producedAt: string | null;
  expiresAt: string | null;
}
export interface Receipt {
  id: string;
  warehouseId: string;
  sourceRef: string;
  status: string;
  version: number;
  lines: ReceiptLine[];
}
export interface SaleSku {
  id: string;
  productId: string;
  name: string;
  description: string;
  categoryId: string;
  spec: string;
  unit: string;
  priceCents: number;
  available: number;
}
