BEGIN;
-- AlterTable
ALTER TABLE "stock_balances" ADD COLUMN     "active_count_id" UUID;

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'FROZEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "reason" VARCHAR(200) NOT NULL,
    "created_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "review_reason" VARCHAR(200),
    "cancel_reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "posted_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "snapshot_on_hand" INTEGER NOT NULL,
    "snapshot_reserved" INTEGER NOT NULL,
    "snapshot_blocked" INTEGER NOT NULL,
    "position_version" INTEGER NOT NULL,
    "counted" INTEGER,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_counts_warehouse_id_sku_id_id_idx" ON "stock_counts"("warehouse_id", "sku_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_id_warehouse_id_sku_id_key" ON "stock_counts"("id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_count_id_position_id_key" ON "stock_count_lines"("count_id", "position_id");

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_active_count_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("active_count_id", "warehouse_id", "sku_id") REFERENCES "stock_counts"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_id_sku_id_fkey" FOREIGN KEY ("warehouse_id", "sku_id") REFERENCES "stock_balances"("warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("count_id", "warehouse_id", "sku_id") REFERENCES "stock_counts"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_position_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX stock_counts_one_active ON stock_counts(warehouse_id,sku_id) WHERE status IN ('FROZEN','SUBMITTED','APPROVED');
ALTER TABLE stock_counts ADD CHECK(version>=0 AND status IN ('FROZEN','SUBMITTED','APPROVED','POSTED','CANCELLED'));
ALTER TABLE stock_counts ADD CHECK(length(trim(reason))>0 AND (status NOT IN ('SUBMITTED','APPROVED','POSTED') OR submitted_at IS NOT NULL));
ALTER TABLE stock_counts ADD CHECK(status NOT IN ('APPROVED','POSTED') OR (reviewed_by IS NOT NULL AND reviewed_by<>created_by AND reviewed_at IS NOT NULL AND length(trim(review_reason))>0));
ALTER TABLE stock_counts ADD CHECK((status='POSTED')=(posted_at IS NOT NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL));
ALTER TABLE stock_counts ADD CHECK(status<>'CANCELLED' OR length(trim(cancel_reason))>0);
ALTER TABLE stock_count_lines ADD CHECK(snapshot_on_hand BETWEEN 0 AND 1000000000 AND snapshot_reserved>=0 AND snapshot_blocked>=0 AND snapshot_reserved+snapshot_blocked<=snapshot_on_hand AND position_version>=0);
ALTER TABLE stock_count_lines ADD CHECK(counted IS NULL OR counted BETWEEN snapshot_reserved+snapshot_blocked AND 1000000000);

CREATE FUNCTION yumi_count_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'count documents cannot be deleted'; END IF;
  IF OLD.status IN ('POSTED','CANCELLED') OR NEW.version<>OLD.version+1 OR
    ROW(NEW.id,NEW.warehouse_id,NEW.sku_id,NEW.reason,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.warehouse_id,OLD.sku_id,OLD.reason,OLD.created_by,OLD.created_at) OR
    NOT ((OLD.status='FROZEN' AND NEW.status IN ('SUBMITTED','CANCELLED')) OR (OLD.status='SUBMITTED' AND NEW.status IN ('APPROVED','CANCELLED')) OR (OLD.status='APPROVED' AND NEW.status IN ('POSTED','CANCELLED')))
  THEN RAISE EXCEPTION 'invalid count transition'; END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'submission is immutable'; END IF;
  IF OLD.reviewed_at IS NOT NULL AND ROW(NEW.reviewed_at,NEW.reviewed_by,NEW.review_reason) IS DISTINCT FROM ROW(OLD.reviewed_at,OLD.reviewed_by,OLD.review_reason) THEN RAISE EXCEPTION 'review is immutable'; END IF;
  IF NEW.status IN ('SUBMITTED','APPROVED','POSTED') AND (NOT EXISTS(SELECT 1 FROM stock_count_lines WHERE count_id=NEW.id) OR EXISTS(SELECT 1 FROM stock_count_lines WHERE count_id=NEW.id AND counted IS NULL)) THEN RAISE EXCEPTION 'incomplete count'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER count_document_guard BEFORE UPDATE OR DELETE ON stock_counts FOR EACH ROW EXECUTE FUNCTION yumi_count_document_guard();
CREATE FUNCTION yumi_count_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'count snapshots cannot be deleted'; END IF;
  SELECT status INTO s FROM stock_counts WHERE id=NEW.count_id;
  IF s<>'FROZEN' OR (TG_OP='UPDATE' AND ((to_jsonb(NEW)-'counted') IS DISTINCT FROM (to_jsonb(OLD)-'counted') OR OLD.counted IS NOT NULL OR NEW.counted IS NULL)) THEN RAISE EXCEPTION 'count snapshot is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER count_line_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_count_lines FOR EACH ROW EXECUTE FUNCTION yumi_count_line_guard();

-- Freeze is independent of reconciliation hold. Existing writers also fail closed.
CREATE FUNCTION yumi_count_stock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.on_hand,NEW.reserved,NEW.blocked) IS NOT DISTINCT FROM ROW(OLD.on_hand,OLD.reserved,OLD.blocked) THEN RETURN NEW; END IF;
  SELECT active_count_id INTO active FROM stock_balances WHERE warehouse_id=NEW.warehouse_id AND sku_id=NEW.sku_id FOR UPDATE;
  IF active IS NOT NULL AND (current_setting('yumi.count_post',true) IS DISTINCT FROM active::text OR NOT EXISTS(SELECT 1 FROM stock_counts WHERE id=active AND status='APPROVED')) THEN RAISE EXCEPTION 'stock frozen for physical count'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER count_balance_freeze BEFORE UPDATE ON stock_balances FOR EACH ROW EXECUTE FUNCTION yumi_count_stock_guard();
CREATE TRIGGER count_lot_freeze BEFORE INSERT OR UPDATE ON stock_lots FOR EACH ROW EXECUTE FUNCTION yumi_count_stock_guard();
CREATE TRIGGER count_position_freeze BEFORE INSERT OR UPDATE ON stock_positions FOR EACH ROW EXECUTE FUNCTION yumi_count_stock_guard();

CREATE FUNCTION yumi_count_hold_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; s uuid; active uuid; expected uuid;
BEGIN
  w:=NEW.warehouse_id; s:=NEW.sku_id;
  SELECT active_count_id INTO active FROM stock_balances WHERE warehouse_id=w AND sku_id=s;
  SELECT id INTO expected FROM stock_counts WHERE warehouse_id=w AND sku_id=s AND status IN ('FROZEN','SUBMITTED','APPROVED');
  IF active IS DISTINCT FROM expected THEN RAISE EXCEPTION 'count freeze and document disagree'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER count_balance_hold_check AFTER INSERT OR UPDATE ON stock_balances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_count_hold_check();
CREATE CONSTRAINT TRIGGER count_document_hold_check AFTER INSERT OR UPDATE ON stock_counts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_count_hold_check();
COMMIT;

