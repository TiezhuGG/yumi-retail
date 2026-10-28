BEGIN;
-- CreateTable
CREATE TABLE "receipt_reversals" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position_version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "reason" VARCHAR(200) NOT NULL,
    "review_reason" VARCHAR(200),
    "cancel_reason" VARCHAR(200),
    "physical_evidence" VARCHAR(200),
    "created_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "posted_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "stock_ledger_id" UUID,

    CONSTRAINT "receipt_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_reversals_stock_ledger_id_key" ON "receipt_reversals"("stock_ledger_id");

-- CreateIndex
CREATE INDEX "receipt_reversals_warehouse_id_sku_id_id_idx" ON "receipt_reversals"("warehouse_id", "sku_id", "id");

-- CreateIndex
CREATE INDEX "receipt_reversals_lot_id_idx" ON "receipt_reversals"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_reversals_stock_ledger_id_warehouse_id_sku_id_lot_i_key" ON "receipt_reversals"("stock_ledger_id", "warehouse_id", "sku_id", "lot_id");

-- AddForeignKey
ALTER TABLE "receipt_reversals" ADD CONSTRAINT "receipt_reversals_lot_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("lot_id", "warehouse_id", "sku_id") REFERENCES "stock_lots"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receipt_reversals" ADD CONSTRAINT "receipt_reversals_position_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receipt_reversals" ADD CONSTRAINT "receipt_reversals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receipt_reversals" ADD CONSTRAINT "receipt_reversals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "receipt_reversals" ADD CONSTRAINT "receipt_reversals_stock_ledger_id_warehouse_id_sku_id_lot__fkey" FOREIGN KEY ("stock_ledger_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE receipt_reversals ADD CHECK(quantity BETWEEN 1 AND 100000 AND position_version>=0 AND version>=0 AND length(trim(reason))>0 AND status IN ('DRAFT','APPROVED','POSTED','CANCELLED'));
ALTER TABLE receipt_reversals ADD CHECK(status NOT IN ('APPROVED','POSTED') OR (reviewed_by IS NOT NULL AND reviewed_by<>created_by AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL AND length(trim(review_reason))>0));
ALTER TABLE receipt_reversals ADD CHECK((status='POSTED')=(posted_at IS NOT NULL) AND (status='POSTED')=(stock_ledger_id IS NOT NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL));
ALTER TABLE receipt_reversals ADD CHECK(status<>'CANCELLED' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason))>0));
ALTER TABLE receipt_reversals ADD CHECK(status<>'POSTED' OR (physical_evidence IS NOT NULL AND length(trim(physical_evidence))>0));
CREATE FUNCTION yumi_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reversal documents cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' OR NEW.version<>0 OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL OR NEW.physical_evidence IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN RAISE EXCEPTION 'invalid initial reversal'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('POSTED','CANCELLED') OR NEW.version<>OLD.version+1 OR
    (to_jsonb(NEW)-ARRAY['status','version','reviewed_by','reviewed_at','review_reason','cancel_reason','physical_evidence','posted_at','cancelled_at','stock_ledger_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','reviewed_by','reviewed_at','review_reason','cancel_reason','physical_evidence','posted_at','cancelled_at','stock_ledger_id']) OR
    NOT ((OLD.status='DRAFT' AND NEW.status IN ('APPROVED','CANCELLED')) OR (OLD.status='APPROVED' AND NEW.status IN ('POSTED','CANCELLED')))
  THEN RAISE EXCEPTION 'invalid reversal transition or mutable intent'; END IF;
  IF OLD.reviewed_at IS NOT NULL AND ROW(NEW.reviewed_at,NEW.reviewed_by,NEW.review_reason) IS DISTINCT FROM ROW(OLD.reviewed_at,OLD.reviewed_by,OLD.review_reason) THEN RAISE EXCEPTION 'review is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reversal_guard BEFORE INSERT OR UPDATE OR DELETE ON receipt_reversals FOR EACH ROW EXECUTE FUNCTION yumi_reversal_guard();

CREATE FUNCTION yumi_reversal_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_quantity bigint; original_status text;
BEGIN
  -- The API serializes on balance; this lock also serializes deferred cap checks
  -- across different positions of the same original receipt lot.
  PERFORM id FROM stock_lots WHERE id=NEW.lot_id FOR UPDATE;
  SELECT l.quantity,r.status INTO STRICT original_quantity,original_status
    FROM stock_lots b JOIN inbound_lines l ON l.id=b.receipt_line_id
    JOIN inbound_receipts r ON r.id=l.receipt_id WHERE b.id=NEW.lot_id;
  IF original_status<>'POSTED' OR (SELECT COALESCE(SUM(quantity),0) FROM receipt_reversals WHERE lot_id=NEW.lot_id AND status='POSTED')>original_quantity
  THEN RAISE EXCEPTION 'original posted receipt reversal capacity exceeded'; END IF;
  IF EXISTS(SELECT 1 FROM receipt_reversals d LEFT JOIN stock_ledger e ON e.id=d.stock_ledger_id
    WHERE d.lot_id=NEW.lot_id AND d.status='POSTED' AND
      (e.id IS NULL OR e.action_key<>'RECEIPT_REVERSE:'||d.id::text OR e.delta_on_hand<>-d.quantity OR e.delta_reserved<>0 OR e.delta_blocked<>0 OR
      (SELECT COUNT(*) FROM position_ledger p WHERE p.stock_ledger_id=e.id)<>1 OR
      NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=e.id AND p.position_id=d.position_id AND p.delta_on_hand=-d.quantity AND p.delta_reserved=0 AND p.delta_blocked=0)))
  THEN RAISE EXCEPTION 'reversal ledger evidence missing'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reversal_facts AFTER INSERT OR UPDATE ON receipt_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_reversal_facts();
CREATE FUNCTION yumi_posted_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='inbound_receipts' THEN
    IF OLD.status='POSTED' THEN RAISE EXCEPTION 'posted receipt is immutable'; END IF;
  ELSE
    IF TG_OP='INSERT' THEN
      IF EXISTS(SELECT 1 FROM inbound_receipts WHERE id=NEW.receipt_id AND status='POSTED') THEN RAISE EXCEPTION 'cannot append line to posted receipt'; END IF;
      RETURN NEW;
    END IF;
    IF EXISTS(SELECT 1 FROM inbound_receipts WHERE id=OLD.receipt_id AND status='POSTED') THEN RAISE EXCEPTION 'posted receipt lines are immutable'; END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM inbound_receipts WHERE id=NEW.receipt_id AND status='POSTED') THEN RAISE EXCEPTION 'cannot attach line to posted receipt'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posted_receipt_guard BEFORE UPDATE OR DELETE ON inbound_receipts FOR EACH ROW EXECUTE FUNCTION yumi_posted_receipt_guard();
CREATE TRIGGER posted_receipt_line_guard BEFORE INSERT OR UPDATE OR DELETE ON inbound_lines FOR EACH ROW EXECUTE FUNCTION yumi_posted_receipt_guard();
CREATE FUNCTION yumi_lot_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.receipt_line_id,NEW.warehouse_id,NEW.sku_id,NEW.batch_no,NEW.unit_cost_cents) IS DISTINCT FROM ROW(OLD.receipt_line_id,OLD.warehouse_id,OLD.sku_id,OLD.batch_no,OLD.unit_cost_cents) THEN RAISE EXCEPTION 'receipt lot provenance is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lot_source_guard BEFORE UPDATE ON stock_lots FOR EACH ROW EXECUTE FUNCTION yumi_lot_source_guard();
COMMIT;

