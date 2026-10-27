BEGIN;
-- Stop application writers before deployment. Block concurrent legacy writes during backfill.
LOCK TABLE warehouses,stock_balances,stock_lots,stock_ledger IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM stock_balances b LEFT JOIN (
      SELECT warehouse_id,sku_id,SUM(on_hand) h,SUM(reserved) r,SUM(blocked) x FROM stock_lots GROUP BY warehouse_id,sku_id
    ) l USING(warehouse_id,sku_id)
    WHERE ROW(b.on_hand,b.reserved,b.blocked) IS DISTINCT FROM ROW(COALESCE(l.h,0),COALESCE(l.r,0),COALESCE(l.x,0))
  ) OR EXISTS (
    SELECT 1 FROM stock_lots l LEFT JOIN (
      SELECT lot_id,SUM(delta_on_hand) h,SUM(delta_reserved) r,SUM(delta_blocked) x FROM stock_ledger GROUP BY lot_id
    ) e ON e.lot_id=l.id
    WHERE ROW(l.on_hand,l.reserved,l.blocked) IS DISTINCT FROM ROW(COALESCE(e.h,0),COALESCE(e.r,0),COALESCE(e.x,0))
  ) THEN RAISE EXCEPTION 'Legacy inventory mismatch: migration stopped without repairing quantities'; END IF;
END $$;
-- AlterTable
ALTER TABLE "stock_balances" ADD COLUMN     "inventory_hold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE business_audits ADD COLUMN reason VARCHAR(200);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_positions" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stock_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_ledger" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "stock_ledger_id" UUID NOT NULL,
    "delta_on_hand" INTEGER NOT NULL,
    "delta_reserved" INTEGER NOT NULL,
    "delta_blocked" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "source_position_id" UUID NOT NULL,
    "target_position_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "stock_ledger_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_checks" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "issue_count" INTEGER NOT NULL,
    "issues" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_warehouse_id_code_key" ON "warehouse_locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_id_warehouse_id_key" ON "warehouse_locations"("id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_positions_warehouse_id_sku_id_id_idx" ON "stock_positions"("warehouse_id", "sku_id", "id");

-- CreateIndex
CREATE INDEX "stock_positions_location_id_idx" ON "stock_positions"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_lot_id_location_id_key" ON "stock_positions"("lot_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_positions_id_warehouse_id_sku_id_lot_id_key" ON "stock_positions"("id", "warehouse_id", "sku_id", "lot_id");

-- CreateIndex
CREATE INDEX "position_ledger_position_id_idx" ON "position_ledger"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "position_ledger_stock_ledger_id_position_id_key" ON "position_ledger"("stock_ledger_id", "position_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_stock_ledger_id_key" ON "stock_transfers"("stock_ledger_id");

-- CreateIndex
CREATE INDEX "stock_transfers_warehouse_id_created_at_id_idx" ON "stock_transfers"("warehouse_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_stock_ledger_id_warehouse_id_sku_id_lot_id_key" ON "stock_transfers"("stock_ledger_id", "warehouse_id", "sku_id", "lot_id");

-- CreateIndex
CREATE INDEX "inventory_checks_warehouse_id_sku_id_created_at_idx" ON "inventory_checks"("warehouse_id", "sku_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_id_warehouse_id_sku_id_lot_id_key" ON "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id");

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_positions" ADD CONSTRAINT "stock_positions_lot_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("lot_id", "warehouse_id", "sku_id") REFERENCES "stock_lots"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_positions" ADD CONSTRAINT "stock_positions_location_id_warehouse_id_fkey" FOREIGN KEY ("location_id", "warehouse_id") REFERENCES "warehouse_locations"("id", "warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "position_ledger" ADD CONSTRAINT "position_ledger_position_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "position_ledger" ADD CONSTRAINT "position_ledger_stock_ledger_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("stock_ledger_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_position_id_warehouse_id_sku_id_lot_fkey" FOREIGN KEY ("source_position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_target_position_id_warehouse_id_sku_id_lot_fkey" FOREIGN KEY ("target_position_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_positions"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_stock_ledger_id_warehouse_id_sku_id_lot_id_fkey" FOREIGN KEY ("stock_ledger_id", "warehouse_id", "sku_id", "lot_id") REFERENCES "stock_ledger"("id", "warehouse_id", "sku_id", "lot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_checks" ADD CONSTRAINT "inventory_checks_warehouse_id_sku_id_fkey" FOREIGN KEY ("warehouse_id", "sku_id") REFERENCES "stock_balances"("warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_checks" ADD CONSTRAINT "inventory_checks_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE warehouse_locations ADD CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$' AND version>=0);
ALTER TABLE stock_positions ADD CHECK (on_hand BETWEEN 0 AND 1000000000 AND reserved>=0 AND blocked>=0 AND reserved+blocked<=on_hand AND version>=0);
ALTER TABLE stock_transfers ADD CHECK (quantity BETWEEN 1 AND 100000 AND source_position_id<>target_position_id);
ALTER TABLE inventory_checks ADD CHECK (status IN ('CONSISTENT','DIFFERENCES') AND issue_count>=0 AND (status='CONSISTENT')=(issue_count=0));

INSERT INTO warehouse_locations(id,warehouse_id,code,name)
SELECT gen_random_uuid(),id,'DEFAULT','默认收货位' FROM warehouses;
INSERT INTO warehouse_locations(id,warehouse_id,code,name)
SELECT gen_random_uuid(),warehouse_id,location_code,location_code FROM stock_lots WHERE location_code<>'DEFAULT' GROUP BY warehouse_id,location_code;
INSERT INTO stock_positions(id,warehouse_id,sku_id,lot_id,location_id,on_hand,reserved,blocked)
SELECT l.id,l.warehouse_id,l.sku_id,l.id,p.id,l.on_hand,l.reserved,l.blocked FROM stock_lots l JOIN warehouse_locations p ON p.warehouse_id=l.warehouse_id AND p.code=l.location_code;
INSERT INTO position_ledger(id,position_id,warehouse_id,sku_id,lot_id,stock_ledger_id,delta_on_hand,delta_reserved,delta_blocked,created_at)
SELECT e.id,e.lot_id,e.warehouse_id,e.sku_id,e.lot_id,e.id,e.delta_on_hand,e.delta_reserved,e.delta_blocked,e.created_at FROM stock_ledger e;

CREATE FUNCTION yumi_default_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO warehouse_locations(id,warehouse_id,code,name) VALUES(gen_random_uuid(),NEW.id,'DEFAULT','默认收货位'); RETURN NEW; END $$;
CREATE TRIGGER warehouse_default_location AFTER INSERT ON warehouses FOR EACH ROW EXECUTE FUNCTION yumi_default_location();
CREATE TRIGGER position_ledger_append_only BEFORE UPDATE OR DELETE ON position_ledger FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER stock_transfers_append_only BEFORE UPDATE OR DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER inventory_checks_append_only BEFORE UPDATE OR DELETE ON inventory_checks FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();

CREATE FUNCTION yumi_verify_position_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id uuid; main_row record; total record;
BEGIN
  IF TG_TABLE_NAME='stock_ledger' THEN event_id:=NEW.id; ELSE event_id:=NEW.stock_ledger_id; END IF;
  SELECT delta_on_hand h,delta_reserved r,delta_blocked x INTO main_row FROM stock_ledger WHERE id=event_id;
  SELECT COALESCE(SUM(delta_on_hand),0) h,COALESCE(SUM(delta_reserved),0) r,COALESCE(SUM(delta_blocked),0) x INTO total FROM position_ledger WHERE stock_ledger_id=event_id;
  IF ROW(main_row.h,main_row.r,main_row.x) IS DISTINCT FROM ROW(total.h,total.r,total.x) THEN
    RAISE EXCEPTION 'Inventory event must balance its position entries';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_event_position_balance AFTER INSERT ON stock_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_position_event();
CREATE CONSTRAINT TRIGGER position_event_balance AFTER INSERT ON position_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yumi_verify_position_event();
COMMIT;
