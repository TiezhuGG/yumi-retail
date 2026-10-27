-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "parent_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "spec" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "expiry_managed" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_receipts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "source_ref" VARCHAR(100) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "posted_at" TIMESTAMPTZ(3),

    CONSTRAINT "inbound_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_no" VARCHAR(64) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_cents" BIGINT NOT NULL,
    "produced_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "inbound_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "safety" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("warehouse_id","sku_id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "batch_no" VARCHAR(64) NOT NULL,
    "location_code" VARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
    "on_hand" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" BIGINT NOT NULL,
    "produced_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "action_key" VARCHAR(128) NOT NULL,
    "delta_on_hand" INTEGER NOT NULL,
    "delta_reserved" INTEGER NOT NULL DEFAULT 0,
    "delta_blocked" INTEGER NOT NULL DEFAULT 0,
    "actor_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_audits" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "resource_id" UUID NOT NULL,
    "warehouse_id" UUID,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" VARCHAR(200) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key_hash")
);

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX "products_category_id_status_id_idx" ON "products"("category_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "skus_code_key" ON "skus"("code");

-- CreateIndex
CREATE INDEX "skus_product_id_idx" ON "skus"("product_id");

-- CreateIndex
CREATE INDEX "inbound_receipts_warehouse_id_created_at_id_idx" ON "inbound_receipts"("warehouse_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_receipts_id_warehouse_id_key" ON "inbound_receipts"("id", "warehouse_id");

-- CreateIndex
CREATE INDEX "inbound_lines_receipt_id_idx" ON "inbound_lines"("receipt_id");

-- CreateIndex
CREATE INDEX "inbound_lines_sku_id_idx" ON "inbound_lines"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_lines_id_warehouse_id_sku_id_key" ON "inbound_lines"("id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE INDEX "stock_balances_sku_id_idx" ON "stock_balances"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_receipt_line_id_key" ON "stock_lots"("receipt_line_id");

-- CreateIndex
CREATE INDEX "stock_lots_warehouse_id_sku_id_expires_at_id_idx" ON "stock_lots"("warehouse_id", "sku_id", "expires_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_receipt_line_id_warehouse_id_sku_id_key" ON "stock_lots"("receipt_line_id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_id_warehouse_id_sku_id_key" ON "stock_lots"("id", "warehouse_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_action_key_key" ON "stock_ledger"("action_key");

-- CreateIndex
CREATE INDEX "stock_ledger_warehouse_id_sku_id_created_at_idx" ON "stock_ledger"("warehouse_id", "sku_id", "created_at");

-- CreateIndex
CREATE INDEX "business_audits_resource_id_created_at_idx" ON "business_audits"("resource_id", "created_at");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_lines" ADD CONSTRAINT "inbound_lines_receipt_id_warehouse_id_fkey" FOREIGN KEY ("receipt_id", "warehouse_id") REFERENCES "inbound_receipts"("id", "warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbound_lines" ADD CONSTRAINT "inbound_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_warehouse_id_sku_id_fkey" FOREIGN KEY ("warehouse_id", "sku_id") REFERENCES "stock_balances"("warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_receipt_line_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("receipt_line_id", "warehouse_id", "sku_id") REFERENCES "inbound_lines"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_lot_id_warehouse_id_sku_id_fkey" FOREIGN KEY ("lot_id", "warehouse_id", "sku_id") REFERENCES "stock_lots"("id", "warehouse_id", "sku_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "business_audits" ADD CONSTRAINT "business_audits_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Invariants not expressible in Prisma schema; retain in migrations.
ALTER TABLE products ADD CHECK (status IN ('DRAFT','PUBLISHED','UNPUBLISHED') AND version >= 0);
ALTER TABLE categories ADD CHECK (parent_id IS NULL OR parent_id <> id);
ALTER TABLE skus ADD CHECK (price_cents BETWEEN 1 AND 100000000);
ALTER TABLE inbound_receipts ADD CHECK (status IN ('DRAFT','APPROVED','POSTED') AND version >= 0);
ALTER TABLE inbound_receipts ADD CHECK (
  (status='DRAFT' AND reviewed_by IS NULL AND reviewed_at IS NULL AND posted_at IS NULL) OR
  (status='APPROVED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_at IS NULL) OR
  (status='POSTED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_at IS NOT NULL));
ALTER TABLE inbound_lines ADD CHECK (quantity BETWEEN 1 AND 100000 AND unit_cost_cents BETWEEN 0 AND 100000000);
ALTER TABLE inbound_lines ADD CHECK ((produced_at IS NULL) = (expires_at IS NULL));
ALTER TABLE inbound_lines ADD CHECK (expires_at IS NULL OR expires_at > produced_at);
ALTER TABLE stock_balances ADD CHECK (on_hand BETWEEN 0 AND 1000000000 AND reserved >= 0 AND blocked >= 0 AND safety >= 0 AND reserved+blocked <= on_hand AND version >= 0);
ALTER TABLE stock_lots ADD CHECK (on_hand BETWEEN 0 AND 1000000000 AND reserved >= 0 AND blocked >= 0 AND reserved+blocked <= on_hand AND unit_cost_cents BETWEEN 0 AND 100000000);
ALTER TABLE stock_lots ADD CHECK ((produced_at IS NULL) = (expires_at IS NULL));
ALTER TABLE stock_lots ADD CHECK (expires_at IS NULL OR expires_at > produced_at);
ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_actor_id_fkey FOREIGN KEY(actor_id) REFERENCES staff(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Database-level append-only protection, including accidental ORM updates/deletes.
CREATE FUNCTION yumi_reject_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only business fact'; END $$;
CREATE TRIGGER stock_ledger_append_only BEFORE UPDATE OR DELETE ON stock_ledger FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE TRIGGER business_audits_append_only BEFORE UPDATE OR DELETE ON business_audits FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
