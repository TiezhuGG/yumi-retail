CREATE TABLE redemption_express_receipts (
 shipment_id uuid PRIMARY KEY REFERENCES redemption_express_shipments(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, confirmed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER express_receipt_immutable BEFORE UPDATE OR DELETE ON redemption_express_receipts FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_express_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM redemption_express_shipments s JOIN redemption_orders o ON o.id=s.order_id JOIN redemption_outbox j ON j.order_id=o.id JOIN consumer_users u ON u.id=o.user_id WHERE s.id=NEW.shipment_id AND o.user_id=NEW.user_id AND u.enabled AND o.status='ACTIVE' AND o.delivery_mode='EXPRESS' AND j.state='EXPRESS_SHIPPED' AND NEW.confirmed_at>=s.created_at) THEN RAISE EXCEPTION 'Own active shipped express order required for receipt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER express_receipt_source BEFORE INSERT ON redemption_express_receipts FOR EACH ROW EXECUTE FUNCTION protect_express_receipt();
