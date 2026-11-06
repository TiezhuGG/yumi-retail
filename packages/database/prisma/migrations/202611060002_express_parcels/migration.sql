BEGIN;
-- Keep old single-order facts unchanged. Multi-order parcels are immutable atomic facts.
CREATE TABLE redemption_express_parcels (
 id uuid PRIMARY KEY,
 warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES consumer_users(id) ON DELETE RESTRICT,
 execution_mode varchar(20) NOT NULL CHECK(execution_mode IN ('DEVELOPMENT','CONTROLLED','PRODUCTION')),
 order_ids uuid[] NOT NULL CHECK(cardinality(order_ids) BETWEEN 2 AND 20 AND array_position(order_ids,NULL) IS NULL),
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER express_parcel_immutable BEFORE UPDATE OR DELETE ON redemption_express_parcels FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
ALTER TABLE redemption_express_shipments ADD COLUMN parcel_id uuid REFERENCES redemption_express_parcels(id) ON DELETE RESTRICT;
CREATE INDEX express_parcel_members ON redemption_express_shipments(parcel_id);
-- Global original + historical identity exclusion is retained by the waybill claim PK.
ALTER TABLE redemption_express_shipments DROP CONSTRAINT redemption_express_tracking_key;
CREATE OR REPLACE FUNCTION claim_express_waybill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; w uuid; owner uuid;
BEGIN
 IF TG_TABLE_NAME='redemption_express_shipments' THEN sid:=COALESCE(NEW.parcel_id,NEW.id); w:=NEW.warehouse_id;
 ELSE SELECT COALESCE(parcel_id,id),warehouse_id INTO sid,w FROM redemption_express_shipments WHERE id=NEW.shipment_id; END IF;
 INSERT INTO redemption_express_waybills(warehouse_id,carrier_code,carrier_name,tracking_no,shipment_id)
 VALUES(w,NEW.carrier_code,NEW.carrier_name,NEW.tracking_no,sid) ON CONFLICT DO NOTHING;
 SELECT shipment_id INTO owner FROM redemption_express_waybills WHERE warehouse_id=w AND carrier_code=NEW.carrier_code AND carrier_name=NEW.carrier_name AND tracking_no=NEW.tracking_no;
 IF owner IS DISTINCT FROM sid THEN RAISE EXCEPTION 'Tracking identity already belongs to another shipment or parcel' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION verify_express_parcel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; p record;
BEGIN
 IF TG_TABLE_NAME='redemption_express_parcels' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='redemption_express_shipments' THEN target:=NEW.parcel_id;
 ELSE SELECT parcel_id INTO target FROM redemption_express_shipments WHERE id=NEW.shipment_id; END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM redemption_express_parcels WHERE id=target;
 IF p.id IS NULL OR
  cardinality(p.order_ids)<>(SELECT count(DISTINCT x) FROM unnest(p.order_ids) x) OR
  (SELECT count(*) FROM redemption_express_shipments WHERE parcel_id=target)<>cardinality(p.order_ids) OR
  NOT EXISTS(SELECT 1 FROM redemption_express_shipments WHERE id=target AND parcel_id=target AND order_id=p.order_ids[1]) OR
  EXISTS(SELECT 1 FROM redemption_express_shipments s JOIN redemption_orders o ON o.id=s.order_id WHERE s.parcel_id=target AND
   (NOT(s.order_id=ANY(p.order_ids)) OR s.warehouse_id<>p.warehouse_id OR o.user_id<>p.user_id OR o.execution_mode<>p.execution_mode OR s.actor_id<>p.actor_id OR s.request_id<>p.request_id)) OR
  (SELECT count(DISTINCT (carrier_code,carrier_name,tracking_no)) FROM redemption_express_shipments WHERE parcel_id=target)<>1 OR
  (SELECT count(DISTINCT (COALESCE(c.version,0),COALESCE(c.carrier_code,s.carrier_code),COALESCE(c.carrier_name,s.carrier_name),COALESCE(c.tracking_no,s.tracking_no),c.reason,c.actor_id,c.request_id))
   FROM redemption_express_shipments s LEFT JOIN LATERAL (SELECT * FROM redemption_express_shipment_corrections WHERE shipment_id=s.id ORDER BY version DESC LIMIT 1) c ON true WHERE s.parcel_id=target)<>1
 THEN RAISE EXCEPTION 'Parcel requires exact same-owner/mode membership and synchronized tracking facts'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER express_parcel_complete AFTER INSERT ON redemption_express_parcels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_express_parcel();
CREATE CONSTRAINT TRIGGER express_parcel_member_complete AFTER INSERT ON redemption_express_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_express_parcel();
CREATE CONSTRAINT TRIGGER express_parcel_correction_complete AFTER INSERT ON redemption_express_shipment_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_express_parcel();

COMMIT;
