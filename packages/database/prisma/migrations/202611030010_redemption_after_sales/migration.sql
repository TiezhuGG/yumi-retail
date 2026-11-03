CREATE TABLE redemption_after_sales (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES redemption_orders(id) ON DELETE RESTRICT,
 user_id uuid NOT NULL REFERENCES consumer_users(id), warehouse_id uuid NOT NULL REFERENCES warehouses(id),
 category varchar(24) NOT NULL CHECK(category IN ('NOT_RECEIVED','DAMAGED','WRONG_ITEM','OTHER')),
 status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PROCESSING','CLOSED')),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX redemption_after_sales_warehouse_id_status_id_idx ON redemption_after_sales(warehouse_id,status,id);
CREATE TABLE redemption_after_sales_events (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES redemption_after_sales(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>=0), kind varchar(24) NOT NULL CHECK(kind IN ('SUBMITTED','SUPPLEMENTED','REOPENED','REPLIED','CLOSED')),
 status varchar(20) NOT NULL CHECK(status IN ('OPEN','PROCESSING','CLOSED')),
 message_payload text NOT NULL CHECK(message_payload LIKE 'v1.%'),
 consumer_id uuid REFERENCES consumer_users(id),staff_id uuid REFERENCES staff(id),staff_name varchar(80),
 request_id uuid NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(case_id,version),
 CHECK((kind IN ('SUBMITTED','SUPPLEMENTED','REOPENED') AND consumer_id IS NOT NULL AND staff_id IS NULL AND staff_name IS NULL) OR (kind IN ('REPLIED','CLOSED') AND consumer_id IS NULL AND staff_id IS NOT NULL AND length(trim(staff_name))>0))
);
CREATE TRIGGER after_sales_event_immutable BEFORE UPDATE OR DELETE ON redemption_after_sales_events FOR EACH ROW EXECUTE FUNCTION yumi_reject_fact_mutation();
CREATE FUNCTION protect_after_sales() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'After sales history cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>0 OR NEW.status<>'OPEN' OR NOT EXISTS(SELECT 1 FROM redemption_orders o JOIN redemption_express_shipments s ON s.order_id=o.id JOIN redemption_outbox j ON j.order_id=o.id WHERE o.id=NEW.order_id AND o.user_id=NEW.user_id AND o.warehouse_id=NEW.warehouse_id AND o.status='ACTIVE' AND o.delivery_mode='EXPRESS' AND j.state='EXPRESS_SHIPPED') THEN RAISE EXCEPTION 'After sales requires original active shipped express order'; END IF;
 ELSE
  IF (NEW.id,NEW.order_id,NEW.user_id,NEW.warehouse_id,NEW.category,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.user_id,OLD.warehouse_id,OLD.category,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'After sales immutable source or invalid revision'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER after_sales_source BEFORE INSERT OR UPDATE OR DELETE ON redemption_after_sales FOR EACH ROW EXECUTE FUNCTION protect_after_sales();
CREATE FUNCTION protect_after_sales_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; p record;
BEGIN
 SELECT * INTO c FROM redemption_after_sales WHERE id=NEW.case_id FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'After sales source required'; END IF;
 SELECT * INTO p FROM redemption_after_sales_events WHERE case_id=c.id ORDER BY version DESC LIMIT 1;
 IF p.id IS NULL THEN
  IF NEW.version<>0 OR NEW.kind<>'SUBMITTED' OR NEW.status<>'OPEN' THEN RAISE EXCEPTION 'Initial feedback required'; END IF;
 ELSE
  IF NEW.version<>p.version+1 OR NOT ((NEW.kind='SUPPLEMENTED' AND p.status IN ('OPEN','PROCESSING') AND NEW.status=p.status) OR (NEW.kind='REOPENED' AND p.status='CLOSED' AND NEW.status='OPEN') OR (NEW.kind='REPLIED' AND p.status IN ('OPEN','PROCESSING') AND NEW.status='PROCESSING') OR (NEW.kind='CLOSED' AND p.status IN ('OPEN','PROCESSING') AND NEW.status='CLOSED')) THEN RAISE EXCEPTION 'Invalid after sales action or revision'; END IF;
 END IF;
 IF NEW.consumer_id IS NOT NULL AND (NEW.consumer_id<>c.user_id OR NOT EXISTS(SELECT 1 FROM consumer_users WHERE id=NEW.consumer_id AND enabled)) THEN RAISE EXCEPTION 'Original current consumer required'; END IF;
 IF NEW.staff_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id WHERE s.id=NEW.staff_id AND s.enabled AND s.display_name=NEW.staff_name AND r.role_code IN ('SUPER_ADMIN','OPERATIONS') AND w.warehouse_id=c.warehouse_id) THEN RAISE EXCEPTION 'Current scoped staff required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER after_sales_action BEFORE INSERT ON redemption_after_sales_events FOR EACH ROW EXECUTE FUNCTION protect_after_sales_event();
CREATE FUNCTION verify_after_sales() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;c record;e record;
BEGIN
 IF TG_TABLE_NAME='redemption_after_sales' THEN target:=NEW.id; ELSE target:=NEW.case_id; END IF;
 SELECT * INTO c FROM redemption_after_sales WHERE id=target;
 SELECT * INTO e FROM redemption_after_sales_events WHERE case_id=target ORDER BY version DESC LIMIT 1;
 IF e.id IS NULL OR e.version<>c.version OR e.status<>c.status OR (SELECT count(*) FROM redemption_after_sales_events WHERE case_id=target)<>c.version+1 OR c.updated_at<>e.created_at THEN RAISE EXCEPTION 'After sales projection must match complete immutable history'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER after_sales_complete AFTER INSERT OR UPDATE ON redemption_after_sales DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_after_sales();
CREATE CONSTRAINT TRIGGER after_sales_event_complete AFTER INSERT ON redemption_after_sales_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_after_sales();
