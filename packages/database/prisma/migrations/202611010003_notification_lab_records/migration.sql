-- Synthetic isolation only. Deliberately no order/payment relation or processing state.
CREATE TABLE notification_lab_records (
 id UUID PRIMARY KEY,
 warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 notification_id VARCHAR(128) NOT NULL CHECK(notification_id LIKE 'SYNTHETIC_%'),
 out_trade_no VARCHAR(32) NOT NULL CHECK(out_trade_no LIKE 'SYNTHETIC_%'),
 transaction_id VARCHAR(64) NOT NULL CHECK(transaction_id LIKE 'SYNTHETIC_%'),
 amount_cents BIGINT NOT NULL CHECK(amount_cents>=0 AND amount_cents<=9007199254740991),
 currency VARCHAR(3) NOT NULL CHECK(currency='CNY'),
 success_time VARCHAR(40) NOT NULL,
 facts_hash VARCHAR(64) NOT NULL CHECK(facts_hash ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(warehouse_id,notification_id)
);
CREATE INDEX notification_lab_records_warehouse_created_idx ON notification_lab_records(warehouse_id,created_at,id);
CREATE TRIGGER notification_lab_records_immutable BEFORE UPDATE OR DELETE ON notification_lab_records FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
