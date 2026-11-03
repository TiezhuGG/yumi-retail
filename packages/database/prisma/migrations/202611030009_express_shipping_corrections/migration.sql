-- Append-only clerical corrections. Original shipment and stock facts are untouched.
CREATE TABLE redemption_express_shipment_corrections (
 id uuid PRIMARY KEY, shipment_id uuid NOT NULL REFERENCES redemption_express_shipments(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0),
 carrier_code varchar(20) NOT NULL CHECK(carrier_code IN ('SF','ZTO','YTO','STO','YUNDA','JD','EMS','POST','DEPPON','OTHER')),
 carrier_name varchar(40) NOT NULL CHECK(length(trim(carrier_name))>0 AND carrier_name !~ '[[:cntrl:]]'),
 tracking_no varchar(40) NOT NULL CHECK(tracking_no ~ '^[A-Z0-9][A-Z0-9-]{5,39}$'),
 reason varchar(200) NOT NULL CHECK(length(trim(reason))>0 AND reason !~ '[[:cntrl:]]'),
 actor_id uuid NOT NULL REFERENCES staff(id) ON DELETE RESTRICT, actor_name varchar(80) NOT NULL,
 request_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(shipment_id,version)
);
CREATE TRIGGER express_correction_immutable BEFORE UPDATE OR DELETE ON redemption_express_shipment_corrections FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();

-- Keep every historically used identity claimed, so correcting a typo does not
-- allow a second order to reuse that original or corrected tracking identity.
CREATE TABLE redemption_express_waybills (
 warehouse_id uuid NOT NULL REFERENCES warehouses(id), carrier_code varchar(20) NOT NULL,
 carrier_name varchar(40) NOT NULL, tracking_no varchar(40) NOT NULL,
 shipment_id uuid NOT NULL REFERENCES redemption_express_shipments(id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(warehouse_id,carrier_code,carrier_name,tracking_no)
);
INSERT INTO redemption_express_waybills SELECT warehouse_id,carrier_code,carrier_name,tracking_no,id FROM redemption_express_shipments;
CREATE TRIGGER express_waybill_immutable BEFORE UPDATE OR DELETE ON redemption_express_waybills FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION claim_express_waybill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; w uuid; owner uuid;
BEGIN
 IF TG_TABLE_NAME='redemption_express_shipments' THEN sid:=NEW.id; w:=NEW.warehouse_id;
 ELSE sid:=NEW.shipment_id; SELECT warehouse_id INTO w FROM redemption_express_shipments WHERE id=sid; END IF;
 INSERT INTO redemption_express_waybills(warehouse_id,carrier_code,carrier_name,tracking_no,shipment_id)
 VALUES(w,NEW.carrier_code,NEW.carrier_name,NEW.tracking_no,sid) ON CONFLICT DO NOTHING;
 SELECT shipment_id INTO owner FROM redemption_express_waybills WHERE warehouse_id=w AND carrier_code=NEW.carrier_code AND carrier_name=NEW.carrier_name AND tracking_no=NEW.tracking_no;
 IF owner IS DISTINCT FROM sid THEN RAISE EXCEPTION 'Tracking identity already belongs to another shipment' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER express_ship_waybill AFTER INSERT ON redemption_express_shipments FOR EACH ROW EXECUTE FUNCTION claim_express_waybill();
CREATE TRIGGER express_correction_waybill AFTER INSERT ON redemption_express_shipment_corrections FOR EACH ROW EXECUTE FUNCTION claim_express_waybill();
CREATE FUNCTION verify_express_waybill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM redemption_express_shipments s WHERE s.id=NEW.shipment_id AND s.warehouse_id=NEW.warehouse_id AND
 ((s.carrier_code=NEW.carrier_code AND s.carrier_name=NEW.carrier_name AND s.tracking_no=NEW.tracking_no) OR EXISTS(SELECT 1 FROM redemption_express_shipment_corrections c WHERE c.shipment_id=s.id AND c.carrier_code=NEW.carrier_code AND c.carrier_name=NEW.carrier_name AND c.tracking_no=NEW.tracking_no))) THEN RAISE EXCEPTION 'Tracking claim requires a matching immutable fact'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER express_waybill_source AFTER INSERT ON redemption_express_waybills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_express_waybill();
CREATE FUNCTION protect_express_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; previous record; v integer;
BEGIN
 SELECT * INTO s FROM redemption_express_shipments WHERE id=NEW.shipment_id FOR UPDATE;
 IF s.id IS NULL OR NOT EXISTS(SELECT 1 FROM redemption_orders o JOIN redemption_outbox j ON j.order_id=o.id WHERE o.id=s.order_id AND o.delivery_mode='EXPRESS' AND o.status='ACTIVE' AND j.state='EXPRESS_SHIPPED') THEN RAISE EXCEPTION 'Current active shipped express source required'; END IF;
 SELECT * INTO previous FROM redemption_express_shipment_corrections WHERE shipment_id=s.id ORDER BY version DESC LIMIT 1;
 v:=COALESCE(previous.version,0);
 IF NEW.version<>v+1 THEN RAISE EXCEPTION 'Correction revision must extend current history'; END IF;
 IF (NEW.carrier_code,NEW.carrier_name,NEW.tracking_no)=(COALESCE(previous.carrier_code,s.carrier_code),COALESCE(previous.carrier_name,s.carrier_name),COALESCE(previous.tracking_no,s.tracking_no)) THEN RAISE EXCEPTION 'Correction must change tracking details'; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff a JOIN staff_roles r ON r.staff_id=a.id JOIN staff_warehouses w ON w.staff_id=a.id WHERE a.id=NEW.actor_id AND a.enabled AND a.display_name=NEW.actor_name AND r.role_code IN ('SUPER_ADMIN','OPERATIONS') AND w.warehouse_id=s.warehouse_id) THEN RAISE EXCEPTION 'Current scoped correction staff required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER express_correction_source BEFORE INSERT ON redemption_express_shipment_corrections FOR EACH ROW EXECUTE FUNCTION protect_express_correction();
