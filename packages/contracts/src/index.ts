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
  version: number;
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
}
export interface CategoryDetail extends Category {
  parent: Category | null;
}
export interface SkuSpecUpdate {
  version: number;
  spec: string;
}
export interface SkuBarcodeUpdate {
  version: number;
  barcode: string | null;
}
export interface Sku {
  barcode: string | null;
  id: string;
  productId: string;
  code: string;
  spec: string;
  unit: string;
  priceCents: number;
  expiryManaged: boolean;
  enabled: boolean;
}
export interface ReceiptSkuLookup extends Sku {
  name: string;
}
export interface Product {
  imageId?: string | null;
  id: string;
  categoryId: string;
  name: string;
  description: string;
  status: string;
  version: number;
  skus: Sku[];
}
export interface ProductDetailsUpdate {
  version: number;
  categoryId: string;
  name: string;
  description: string;
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
export interface ReceiptDetailLine extends ReceiptLine {
  sku: {
    name: string;
    code: string;
    spec: string;
    unit: string;
    expiryManaged: boolean;
    enabled: boolean;
  };
}
export interface ReceiptDetail extends Receipt {
  createdAt: string;
  reviewedAt: string | null;
  postedAt: string | null;
  lines: ReceiptDetailLine[];
}

export interface SaleSku {
  imageUrl?: string | null;
  imageUrls?: string[];
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

export interface WarehouseLocation {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  enabled: boolean;
  version: number;
}
export interface StockPosition {
  id: string;
  warehouseId: string;
  skuId: string;
  lotId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  blocked: number;
  version: number;
  locationCode: string;
  locationName: string;
  locationEnabled: boolean;
  batchNo: string;
  producedAt: string | null;
  expiresAt: string | null;
  receivedAt: string;
  expired: boolean;
  name: string;
  spec: string;
  skuCode: string;
}
export interface PositionLedgerEntry {
  id: string;
  positionId: string;
  stockLedgerId: string;
  deltaOnHand: number;
  deltaReserved: number;
  deltaBlocked: number;
  createdAt: string;
  actionKey: string;
  requestId: string;
  reason: string | null;
}
export interface InventoryIssue {
  kind: string;
  resourceId: string;
  expected: { onHand: string; reserved: string; blocked: string };
  actual: { onHand: string; reserved: string; blocked: string };
}
export interface InventoryCheck {
  id: string;
  warehouseId: string;
  skuId: string;
  actorId: string;
  status: string;
  issueCount: number;
  issues: InventoryIssue[];
  createdAt: string;
}

export interface StockCountLine {
  id: string;
  positionId: string;
  lotId: string;
  snapshotOnHand: number;
  snapshotReserved: number;
  snapshotBlocked: number;
  positionVersion: number;
  counted: number | null;
}

export interface StockIsolation {
  id: string;
  warehouseId: string;
  skuId: string;
  lotId: string;
  positionId: string;
  quantity: number;
  remaining: number;
  version: number;
  reason: string;
  createdBy: string;
  createdAt: string;
  stockLedgerId: string;
}
export type ReceiptReversal = Omit<StockDisposition, 'isolationId' | 'kind' | 'isolationVersion'>;
export interface ReceiptReversalSource {
  receiptId: string;
  receiptLineId: string;
  sourceRef: string;
  batchNo: string;
  originalQuantity: number;
  reversedQuantity: number;
  remaining: number;
  positionId: string;
  positionVersion: number;
  freeQuantity: number;
}
export interface StockDisposition {
  id: string;
  warehouseId: string;
  skuId: string;
  lotId: string;
  positionId: string;
  isolationId: string;
  kind: 'RELEASE' | 'DAMAGE';
  quantity: number;
  positionVersion: number;
  isolationVersion: number;
  status: 'DRAFT' | 'APPROVED' | 'POSTED' | 'CANCELLED';
  version: number;
  reason: string;
  reviewReason: string | null;
  cancelReason: string | null;
  physicalEvidence: string | null;
  createdBy: string;
  reviewedBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
  postedAt: string | null;
  cancelledAt: string | null;
  stockLedgerId: string | null;
}
export interface StockCount {
  id: string;
  warehouseId: string;
  skuId: string;
  status: 'FROZEN' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'CANCELLED';
  version: number;
  reason: string;
  createdBy: string;
  reviewedBy: string | null;
  reviewReason: string | null;
  cancelReason: string | null;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  postedAt: string | null;
  cancelledAt: string | null;
  lines: StockCountLine[];
}

export interface ProductGallery {
  product: Product;
  images: { id: string; url: string }[];
}

export interface SaleSkuDetail extends SaleSku {
  variants: SaleSku[];
}
