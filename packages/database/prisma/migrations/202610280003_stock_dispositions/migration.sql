BEGIN;
-- CreateTable
CREATE TABLE "stock_isolations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "reason" VARCHAR(200) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stock_ledger_id" UUID NOT NULL,

    CONSTRAINT "stock_isolations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_dispositions" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "isolation_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position_version" INTEGER NOT NULL,
    "isolation_version" INTEGER NOT NULL,
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

    CONSTRAINT "stock_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_isolations_stock_ledger_id_key" ON "stock_isolations"("stock_ledger_id");

-- CreateIndex
CREATE INDEX "stock_isolations_warehouse_id_sku_id_id_idx" ON "stock_isolations"("warehouse_id", "sku_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_isolations_id_warehouse_id_sku_id_lot_id_position_id_key" ON "stock_isolations"("id", "warehouse_id", "sku_id", "lot_id", "position_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_isolations_stock_ledger_id_warehouse_id_sku_id_lot_id_key" ON "stock_isolations"("stock_ledger_id", "warehouse_id", "sku_id", "lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_dispositions_stock_ledger_id_key" ON "stock_dispositions"("stock_ledger_id");

-- CreateIndex
CREATE INDEX "stock_dispositions_warehouse_id_sku_id_id_idx" ON "stock_dispositions"("warehouse_id", "sku_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_dispositions_stock_ledger_id_warehouse_id_sku_id_lot__key" ON "stock_dispositions"("stock_ledger_id", "warehouse_id", "sku_id", "lot_id");

-- AddForeignKey
ALTER TABLE "stock_isolations" ADD CONSTRAINT "stock_isolations_position_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_isolations" ADD CONSTRAINT "stock_isolations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_isolations" ADD CONSTRAINT "stock_isolations_stock_ledger_id_warehouse_id_sku_id_lot_i_fkey" FOREIGN KEY ("stock_ledger_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_dispositions" ADD CONSTRAINT "stock_dispositions_isolation_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("isolation_id", "warehouse_id", "sku_id", "lot_id", "position_id") REFERENCES "stock_isolations"("id", "warehouse_id", "sku_id", "lot_id", "position_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_dispositions" ADD CONSTRAINT "stock_dispositions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_dispositions" ADD CONSTRAINT "stock_dispositions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_dispositions" ADD CONSTRAINT "stock_dispositions_stock_ledger_id_warehouse_id_sku_id_lot_fkey" FOREIGN KEY ("stock_ledger_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE stock_isolations ADD CHECK(quantity BETWEEN 1 AND 100000 AND remaining BETWEEN 0 AND quantity AND version>=0 AND length(trim(reason))>0);
ALTER TABLE stock_dispositions ADD CHECK(kind IN ('RELEASE','DAMAGE') AND status IN ('DRAFT','APPROVED','POSTED','CANCELLED') AND quantity BETWEEN 1 AND 100000 AND version>=0 AND position_version>=0 AND isolation_version>=0 AND length(trim(reason))>0);
ALTER TABLE stock_dispositions ADD CHECK(status NOT IN ('APPROVED','POSTED') OR (reviewed_by IS NOT NULL AND reviewed_by<>created_by AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL AND length(trim(review_reason))>0));
ALTER TABLE stock_dispositions ADD CHECK((status='POSTED')=(posted_at IS NOT NULL) AND (status='POSTED')=(stock_ledger_id IS NOT NULL) AND (status='CANCELLED')=(cancelled_at IS NOT NULL));
ALTER TABLE stock_dispositions ADD CHECK(status<>'CANCELLED' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason))>0));
ALTER TABLE stock_dispositions ADD CHECK(status<>'POSTED' OR kind<>'DAMAGE' OR (physical_evidence IS NOT NULL AND length(trim(physical_evidence))>0));
CREATE INDEX stock_dispositions_isolation_lookup ON stock_dispositions(isolation_id);

CREATE FUNCTION yumi_isolation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'isolation facts cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.remaining<>NEW.quantity OR NEW.version<>0 THEN RAISE EXCEPTION 'invalid initial isolation'; END IF;
  ELSIF (to_jsonb(NEW)-'remaining'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'remaining'-'version') OR NEW.remaining>=OLD.remaining OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'isolation source is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER isolation_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_isolations FOR EACH ROW EXECUTE FUNCTION yumi_isolation_guard();

CREATE FUNCTION yumi_disposition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'disposition documents cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'DRAFT' OR NEW.version<>0 OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.review_reason IS NOT NULL OR NEW.physical_evidence IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN RAISE EXCEPTION 'invalid initial disposition'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('POSTED','CANCELLED') OR NEW.version<>OLD.version+1 OR
    (to_jsonb(NEW)-ARRAY['status','version','reviewed_by','reviewed_at','review_reason','cancel_reason','physical_evidence','posted_at','cancelled_at','stock_ledger_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','reviewed_by','reviewed_at','review_reason','cancel_reason','physical_evidence','posted_at','cancelled_at','stock_ledger_id']) OR
    NOT ((OLD.status='DRAFT' AND NEW.status IN ('APPROVED','CANCELLED')) OR (OLD.status='APPROVED' AND NEW.status IN ('POSTED','CANCELLED')))
  THEN RAISE EXCEPTION 'invalid disposition transition or mutable intent'; END IF;
  IF OLD.reviewed_at IS NOT NULL AND ROW(NEW.reviewed_at,NEW.reviewed_by,NEW.review_reason) IS DISTINCT FROM ROW(OLD.reviewed_at,OLD.reviewed_by,OLD.review_reason) THEN RAISE EXCEPTION 'review is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER disposition_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_dispositions FOR EACH ROW EXECUTE FUNCTION yumi_disposition_guard();

CREATE FUNCTION yumi_disposition_fact_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE isolation_id_to_check uuid; i stock_isolations%ROWTYPE; remaining_expected bigint;
BEGIN
  IF TG_TABLE_NAME='stock_isolations' THEN isolation_id_to_check:=NEW.id; ELSE isolation_id_to_check:=NEW.isolation_id; END IF;
  SELECT * INTO STRICT i FROM stock_isolations WHERE id=isolation_id_to_check;
  SELECT i.quantity-COALESCE(SUM(quantity),0) INTO remaining_expected FROM stock_dispositions WHERE isolation_id=i.id AND status='POSTED';
  IF i.remaining<>remaining_expected THEN RAISE EXCEPTION 'isolation remaining and posted dispositions disagree'; END IF;
  IF NOT EXISTS(SELECT 1 FROM stock_ledger e WHERE e.id=i.stock_ledger_id AND e.action_key='ISOLATE:'||i.id::text AND e.delta_on_hand=0 AND e.delta_reserved=0 AND e.delta_blocked=i.quantity) OR
    (SELECT COUNT(*) FROM position_ledger p WHERE p.stock_ledger_id=i.stock_ledger_id)<>1 OR
    NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=i.stock_ledger_id AND p.position_id=i.position_id AND p.delta_on_hand=0 AND p.delta_reserved=0 AND p.delta_blocked=i.quantity)
  THEN RAISE EXCEPTION 'isolation ledger evidence missing'; END IF;
  IF EXISTS(
    SELECT 1 FROM stock_dispositions d LEFT JOIN stock_ledger e ON e.id=d.stock_ledger_id
    WHERE d.isolation_id=i.id AND d.status='POSTED' AND
      (e.id IS NULL OR e.action_key<>'DISPOSITION:'||d.id::text OR e.delta_on_hand<>CASE WHEN d.kind='DAMAGE' THEN -d.quantity ELSE 0 END OR e.delta_reserved<>0 OR e.delta_blocked<>-d.quantity OR
       (SELECT COUNT(*) FROM position_ledger p WHERE p.stock_ledger_id=e.id)<>1 OR
       NOT EXISTS(SELECT 1 FROM position_ledger p WHERE p.stock_ledger_id=e.id AND p.position_id=d.position_id AND p.delta_on_hand=e.delta_on_hand AND p.delta_reserved=0 AND p.delta_blocked=e.delta_blocked))
  ) THEN RAISE EXCEPTION 'disposition ledger evidence missing'; END IF;
  IF (SELECT COALESCE(SUM(remaining),0) FROM stock_isolations WHERE position_id=i.position_id)>(SELECT blocked FROM stock_positions WHERE id=i.position_id) THEN RAISE EXCEPTION 'isolation exceeds position blocked stock'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER isolation_facts AFTER INSERT OR UPDATE ON stock_isolations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_disposition_fact_check();
CREATE CONSTRAINT TRIGGER disposition_facts AFTER INSERT OR UPDATE ON stock_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_disposition_fact_check();

CREATE FUNCTION yumi_position_isolation_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(remaining),0) FROM stock_isolations WHERE position_id=NEW.id)>(SELECT blocked FROM stock_positions WHERE id=NEW.id) THEN RAISE EXCEPTION 'blocked stock is still owned by isolations'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER position_isolation_check AFTER INSERT OR UPDATE ON stock_positions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_position_isolation_check();
COMMIT;

