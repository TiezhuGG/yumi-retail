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

export interface PublicCategory {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
}
export interface PublicCategoryPage {
  items: PublicCategory[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProductCard {
  id: string;
  entrySkuId: string;
  name: string;
  categoryId: string;
  imageUrl: string | null;
  spec: string;
  unit: string;
  priceCents: number;
  variantCount: number;
  hasStock: boolean;
}
export interface ProductCardPage {
  items: ProductCard[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ConsumerCartItem {
  skuId: string;
  quantity: number;
  selected: boolean;
  name: string;
  spec: string;
  unit: string;
}
export interface ConsumerCart {
  version: number;
  items: ConsumerCartItem[];
}
export interface CartMergeResult {
  cart: ConsumerCart;
  checks: Array<{ skuId: string; status: 'available' | 'unavailable' | 'excess' | 'unknown' }>;
}

export interface ServiceBuilding {
  id: string;
  name: string;
  enabled: boolean;
}
export interface ServiceAreaDetail {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  warehouse: { id: string; name: string };
  buildings: ServiceBuilding[];
}
export interface PublicServiceArea {
  id: string;
  name: string;
  version: number;
}
export interface PublicServiceBuildings {
  area: PublicServiceArea;
  items: Array<{ id: string; name: string }>;
}

export interface ConsumerAddressInput {
  areaId: string;
  buildingId: string;
  unit: string;
  room: string;
  contactName: string;
  phone: string;
  note: string;
  isDefault: boolean;
}
export interface ConsumerAddress extends ConsumerAddressInput {
  id: string;
  areaName: string;
  buildingName: string;
  available: boolean;
}
export interface ConsumerAddressBook {
  version: number;
  items: ConsumerAddress[];
}
export interface ConsumerAddressReceipt {
  id: string;
  version: number;
}

export interface CheckoutPolicy {
  version: number;
  deliveryFeeCents: number;
  minGoodsCents: number;
  freeDeliveryThresholdCents: number | null;
  open: boolean;
}
export interface CheckoutLine {
  skuId: string;
  name: string;
  spec: string;
  unit: string;
  quantity: number;
  priceCents: number | null;
  lineCents: number | null;
  available: number;
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'EXCESS';
}
export interface CheckoutPreview {
  addressId: string;
  addressVersion: number;
  cartVersion: number;
  policy: CheckoutPolicy | null;
  areaVersion: number | null;
  ready: boolean;
  issues: Array<{ code: string; message: string }>;
  lines: CheckoutLine[];
  goodsCents: number | null;
  deliveryFeeCents: number | null;
  payableCents: number | null;
}
export interface CheckoutQuote {
  id: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  preview: CheckoutPreview;
}

export interface ConsumerOrderAddress {
  areaName: string;
  buildingName: string;
  unit: string;
  room: string;
  contactName: string;
  phone: string;
  note: string;
  orderNote: string;
}
export interface ConsumerOrder {
  id: string;
  orderNo: string;
  status: 'AWAITING_PAYMENT' | 'CANCELED';
  paymentState: 'NOT_STARTED';
  fulfillmentState: 'NOT_READY';
  goodsCents: number;
  deliveryFeeCents: number;
  payableCents: number;
  createdAt: string;
  paymentDeadline: string;
  cancelReason: string | null;
  version: number;
  address: ConsumerOrderAddress;
  items: Array<{
    skuId: string;
    name: string;
    spec: string;
    unit: string;
    quantity: number;
    priceCents: number;
    lineCents: number;
  }>;
}

// Operational read model: no customer identifiers, address/contact data or order notes.
export type AdminOrderSummary = Pick<
  ConsumerOrder,
  | 'id'
  | 'orderNo'
  | 'status'
  | 'paymentState'
  | 'fulfillmentState'
  | 'goodsCents'
  | 'deliveryFeeCents'
  | 'payableCents'
  | 'createdAt'
  | 'paymentDeadline'
  | 'cancelReason'
  | 'items'
>;
export interface AdminOrderDetail extends AdminOrderSummary {
  paymentPreparation: PaymentPreparation | null;
  allocations: Array<{
    id: string;
    skuId: string;
    quantity: number;
    batchNo: string;
    expiresAt: string | null;
    locationCode: string;
    locationName: string;
    reservedAt: string;
    releasedAt: string | null;
  }>;
  events: Array<{ type: string; actorKind: string; createdAt: string }>;
}

export interface PaymentPreparation {
  id: string;
  state: 'PREPARED' | 'CLOSED';
  channel: 'DISABLED';
  amountCents: number;
  currency: 'CNY';
  preparedAt: string;
  closedAt: string | null;
  closeReason: 'CONSUMER_CANCEL' | 'PAYMENT_TIMEOUT' | null;
}
export interface PaymentPreparationView {
  enabled: boolean;
  intent: PaymentPreparation | null;
}

export interface PaymentReadinessCheck {
  code: string;
  title: string;
  group: 'CONFIGURATION' | 'OPERATIONS' | 'IMPLEMENTATION' | 'ACCEPTANCE';
  status: 'MISSING' | 'INVALID' | 'FORMAT_OK' | 'CONFIGURED' | 'UNVERIFIED' | 'BLOCKED';
  detail: string;
}
export interface PaymentReadiness {
  checkedAt: string;
  channel: 'DISABLED';
  canStartPayment: false;
  warehouse: { id: string; name: string };
  checks: PaymentReadinessCheck[];
}

export interface NotificationLabInfo {
  enabled: boolean;
  syntheticOnly: true;
  callbackEnabled: false;
  cases: Array<{ code: string; title: string }>;
}
export interface NotificationLabResult {
  completedAt: string;
  syntheticOnly: true;
  callbackEnabled: false;
  results: Array<{ code: string; title: string; status: 'PASSED' | 'FAILED' }>;
}

export interface NotificationRecord {
  id: string;
  notificationId: string;
  outTradeNo: string;
  transactionId: string;
  amountCents: number;
  currency: string;
  successTime: string;
  createdAt: string;
  syntheticOnly: true;
  state: 'RECORDED_ONLY' | 'LINKED_SYNTHETIC';
  application: { attemptId: string; eventId: string } | null;
}
export interface NotificationRecords {
  enabled: boolean;
  syntheticOnly: true;
  callbackEnabled: false;
  items: NotificationRecord[];
  nextCursor: string | null;
}
export interface NotificationAttemptOptions {
  items: { id: string; label: string; amountCents: number }[];
  nextCursor: string | null;
}
export interface NotificationRecorded {
  applied: boolean;
  record: NotificationRecord;
  duplicate: boolean;
}

export interface PaymentAttemptLabSummary {
  id: string;
  evidence: 'NONE' | 'UNKNOWN' | 'CLOSED' | 'SUCCEEDED' | 'CONFLICT';
  version: number;
  createdAt: string;
  syntheticOnly: true;
  plan: string;
  releaseAllowed: false;
}
export interface PaymentAttemptLabDetail extends PaymentAttemptLabSummary {
  notificationBinding: {
    outTradeNo: string;
    amountCents: number;
    currency: string;
    createdAt: string;
  } | null;
  notifications: { id: string; notificationId: string; createdAt: string }[];
  queryJob: {
    state: string;
    attempts: number;
    nextRunAt: string;
    leaseUntil: string | null;
    events: Array<{
      id: string;
      reason: string;
      classification: string | null;
      resultEvidence: string | null;
      next: string | null;
      scenario: string | null;
      state: string;
      attempts: number;
      createdAt: string;
    }>;
  } | null;
  events: Array<{
    id: string;
    action: string;
    observation: string;
    evidence: string;
    version: number;
    createdAt: string;
  }>;
}
export interface PaymentAttemptLabList {
  queryScenarios: { code: string; title: string }[];
  enabled: boolean;
  syntheticOnly: true;
  callbackEnabled: false;
  items: PaymentAttemptLabSummary[];
  nextCursor: string | null;
}
export interface PaymentAttemptLabWrite {
  attempt: PaymentAttemptLabDetail;
  duplicate: boolean;
}
export interface PaymentReviewCase {
  id: string;
  evidence: string;
  attemptVersion: number;
  taskState: string | null;
  jobVersion: number | null;
  createdAt: string;
  noteCount: number;
  needsReview: boolean;
  syntheticOnly: true;
}
export interface PaymentReviewNote {
  id: string;
  actorName: string;
  note: string;
  evidence: string;
  attemptVersion: number;
  taskState: string | null;
  jobVersion: number | null;
  createdAt: string;
}
export interface PaymentReviewList {
  enabled: boolean;
  syntheticOnly: true;
  items: PaymentReviewCase[];
  nextCursor: string | null;
}
export type PaymentReviewFilter = 'ALL' | 'UNKNOWN' | 'CONFLICT' | 'EXHAUSTED' | 'REVIEW';
export interface PaymentReviewSummary {
  warehouseId: string;
  generatedAt: string;
  syntheticOnly: true;
  enabled: boolean;
  counts: Record<PaymentReviewFilter, number>;
}
export interface PaymentReviewDetail {
  item: PaymentReviewCase;
  notes: PaymentReviewNote[];
  nextNotesCursor: string | null;
}

export type PaymentAdapterLabResult = Omit<NotificationLabResult, 'results'> & {
  results: (NotificationLabResult['results'][number] & {
    classification: string;
    evidence: 'UNKNOWN' | 'SUCCEEDED' | 'CLOSED';
    next: 'RETRY' | 'REVIEW' | 'RECONCILE';
    releaseAllowed: false;
  })[];
};

export type PaymentEvidenceSource = 'ATTEMPT' | 'QUERY' | 'NOTIFICATION' | 'NOTE';
export interface PaymentEvidenceTimelineItem {
  id: string;
  ref: string;
  source: PaymentEvidenceSource;
  createdAt: string;
  title: string;
  entries: { label: string; value: string }[];
  related: { ref: string; label: string }[];
}
export interface PaymentEvidenceTimeline {
  item: PaymentReviewCase;
  items: PaymentEvidenceTimelineItem[];
  nextCursor: string | null;
  filter: 'ALL' | PaymentEvidenceSource;
  focusedRef: string | null;
  syntheticOnly: true;
}

export interface PickingReadinessSummary {
  id: string;
  orderNo: string;
  status: string;
  paymentState: string;
  fulfillmentState: string;
  createdAt: string;
  itemCount: number;
  totalQuantity: number;
}
export interface PickingReadinessDetail extends PickingReadinessSummary {
  checkedAt: string;
  claimEnabled: false;
  blockers: string[];
  items: Array<{
    skuId: string;
    name: string;
    spec: string;
    unit: string;
    quantity: number;
    activeReserved: number;
    allocations: Array<{
      id: string;
      quantity: number;
      batchNo: string;
      expiresAt: string | null;
      locationCode: string;
      locationName: string;
      released: boolean;
      issues: string[];
    }>;
  }>;
}

export interface PickingLabTask {
  packingReadiness: { ready: boolean; blockers: string[] };
  pack: {
    id: string;
    actorName: string;
    packageCount: number;
    singleQuantity: number;
    tripleQuantity: number;
    createdAt: string;
    dispatch: { id: string; actorName: string; createdAt: string } | null;
  } | null;
  id: string;
  label: string;
  state: 'READY' | 'PICKING' | 'CHECKED';
  version: number;
  exceptionVersion: number;
  shortages: Array<{
    id: string;
    lineId: string;
    missingQuantity: number;
    reason: string;
    state: string;
    version: number;
    reporterName: string;
    resolverName: string | null;
    createdAt: string;
    resolvedAt: string | null;
    events: Array<{ action: string; actorName: string; quantity: number; createdAt: string }>;
  }>;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  syntheticOnly: true;
  lines: Array<{
    id: string;
    name: string;
    spec: string;
    unit: string;
    batchNo: string;
    location: string;
    required: number;
    checked: boolean;
  }>;
  events: Array<{
    action: string;
    actorName: string;
    lineId: string | null;
    quantity: number | null;
    createdAt: string;
  }>;
}
export interface PickingLabList {
  enabled: boolean;
  syntheticOnly: true;
  items: PickingLabTask[];
  nextCursor: string | null;
}
export interface PickingLabWrite {
  task: PickingLabTask;
  duplicate: boolean;
}

export type DeliveryTimelineEvent = {
  id: string;
  kind: 'DISPATCH' | 'ASSIGN' | 'HANDOFF' | 'START' | 'EXCEPTION' | 'RESOLVE' | 'COMPLETE';
  createdAt: string;
  actorName: string;
  reason: string | null;
  relatedId: string | null;
};
export type DeliveryLabTask = {
  timeline: DeliveryTimelineEvent[];
  id: string;
  label: string;
  packageCount: number;
  dispatchedAt: string;
  syntheticOnly: true;
  assignment: null | { id: string; riderName: string; actorName: string; createdAt: string };
  handoff: null | { id: string; packageCount: number; createdAt: string };
  journey: {
    start: null | { id: string; createdAt: string };
    completion: null | { id: string; createdAt: string };
  };
  exception: null | {
    id: string;
    reason: string;
    createdAt: string;
    resolution: null | { id: string; actorName: string; createdAt: string };
  };
  handoffReadiness: { ready: boolean; blockers: string[] };
};
export type DeliveryLabList = {
  summary: { all: number; open: number; resolved: number; none: number; readAt: string };
  enabled: boolean;
  selfOnly: boolean;
  items: DeliveryLabTask[];
  nextCursor: string | null;
};

export interface RedemptionQuoteView {
  id: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  snapshot: {
    rewardId: string;
    rewardVersion: number;
    quantity: number;
    addressId: string;
    addressVersion: number;
    title: string;
    name: string;
    spec: string;
    unit: string;
    pointsPrice: string;
    totalPoints: string;
    balance: string;
    remainingBalance: string;
    deliveryMode: 'LOCAL_NO_CASH';
  };
}
export interface RedemptionOrderView {
  deliveryExceptionReported?: boolean;
  id: string;
  orderNo: string;
  status: 'ACTIVE' | 'CANCELED';
  title: string;
  name: string;
  spec: string;
  unit: string;
  quantity: number;
  pointsPrice: string;
  totalPoints: string;
  createdAt: string;
  canceledAt: string | null;
  version: number;
  fulfillmentState:
    | 'PENDING'
    | 'CANCELED'
    | 'MISSING'
    | 'READY_TO_PICK'
    | 'PICKING'
    | 'PICKED_WAIT_PACK'
    | 'PACKED_WAIT_SHIP'
    | 'SHIPPED_WAIT_HANDOFF'
    | 'ASSIGNED_WAIT_HANDOFF'
    | 'RIDER_RECEIVED_WAIT_START'
    | 'DELIVERING'
    | 'DELIVERED'
    | 'REVIEW_REQUIRED';
  address?: ConsumerOrderAddress;
  allocations?: Array<{
    quantity: number;
    batchNo: string;
    locationName: string;
    locationCode: string;
    reserved: boolean;
    released: boolean;
    consumed: boolean;
  }>;
  events?: Array<{ type: string; createdAt: string }>;
}
export interface RedemptionOrderPage {
  items: RedemptionOrderView[];
  nextCursor: string | null;
}

export interface RedemptionPickingView {
  id: string;
  orderNo: string;
  title: string;
  spec: string;
  quantity: number;
  state: string;
  task: null | {
    id: string;
    state: string;
    ownerId: string | null;
    ownerName: string | null;
    version: number;
    claimedAt: string | null;
  };
  job: {
    state: string;
    attempts: number;
    version: number;
    lastErrorCode: string | null;
    nextAttemptAt: string;
    leaseUntil: string | null;
  };
  readiness: { ready: boolean; blockers: string[] };
  packing: {
    canPack: boolean;
    canShip: boolean;
    pack: null | {
      id: string;
      packageCount: number;
      actorId: string;
      createdAt: string;
      lines: Array<{ allocationId: string; quantity: number }>;
    };
    shipment: null | {
      id: string;
      actorId: string;
      createdAt: string;
      deliveryState: 'UNASSIGNED' | 'ASSIGNED' | 'HANDED_OVER' | 'DELIVERING' | 'DELIVERED';
    };
  };
  work: { complete: boolean; canComplete: boolean };
  history: Array<{
    id: string;
    action: string;
    allocationId: string | null;
    quantity: number | null;
    actorId: string;
    createdAt: string;
  }>;
  lines: Array<{
    checked: boolean;
    issue: null | { id: string; kind: string; quantity: number };
    id: string;
    quantity: number;
    batchNo: string;
    locationName: string;
    locationCode: string;
    expiresAt: string | null;
  }>;
}
export interface RedemptionPickingPage {
  enabled: boolean;
  items: RedemptionPickingView[];
  nextCursor: string | null;
}

export interface RedemptionDeliveryView {
  assignmentHistory: Array<{
    id: string;
    riderName: string;
    actorName: string;
    createdAt: string;
    withdrawal: { actorName: string; reason: string; createdAt: string } | null;
  }>;
  exception: null | RedemptionDeliveryIncident;
  exceptionHistory: RedemptionDeliveryIncident[];
  id: string;
  orderNo: string;
  title: string;
  spec: string;
  quantity: number;
  packageCount: number;
  shippedAt: string;
  state: 'UNASSIGNED' | 'ASSIGNED' | 'HANDED_OVER' | 'DELIVERING' | 'DELIVERED';
  assignment: null | {
    id: string;
    riderId: string;
    riderName: string;
    actorName: string;
    createdAt: string;
  };
  handoff: null | { id: string; packageCount: number; createdAt: string };
  journey: {
    start: null | { id: string; createdAt: string };
    completion: null | { id: string; createdAt: string };
  };
  canStart: boolean;
  canComplete: boolean;
  readiness: { ready: boolean; blockers: string[] };
  lines: Array<{
    allocationId: string;
    quantity: number;
    batchNo: string;
    locationName: string;
    locationCode: string;
    expiresAt: string | null;
  }>;
  address?: ConsumerOrderAddress;
}
export interface RedemptionDeliveryPage {
  enabled: boolean;
  selfOnly: boolean;
  items: RedemptionDeliveryView[];
  nextCursor: string | null;
}

export interface RedemptionDeliveryIncident {
  id: string;
  kind: string;
  reason: string;
  createdAt: string;
  resolution: null | { id: string; actorName: string; reason: string; createdAt: string };
}
