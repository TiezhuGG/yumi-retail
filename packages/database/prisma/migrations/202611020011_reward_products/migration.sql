-- P2 catalogue only; no redemption, inventory reservation or points debit.
CREATE TABLE reward_products (
 id uuid PRIMARY KEY,
 warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 sku_id uuid NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
 title varchar(120) NOT NULL CHECK(length(trim(title))>0),
 points_price bigint NOT NULL CHECK(points_price BETWEEN 1 AND 1000000000),
 status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','UNPUBLISHED')),
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 1000000),
 per_user_limit integer NOT NULL CHECK(per_user_limit BETWEEN 1 AND 100000),
 total_quota integer NOT NULL CHECK(total_quota BETWEEN 1 AND 100000000),
 starts_at timestamptz(3), ends_at timestamptz(3),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT reward_products_window CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at),
 CONSTRAINT reward_products_limits CHECK(per_user_limit<=total_quota),
 CONSTRAINT reward_products_sku_unique UNIQUE(warehouse_id,sku_id),
 CONSTRAINT reward_products_source_unique UNIQUE(id,warehouse_id,sku_id)
);
CREATE INDEX reward_products_scope_idx ON reward_products(warehouse_id,status,sort_order,id);
CREATE FUNCTION protect_reward_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reward facts cannot be deleted'; END IF;
 IF NEW.id<>OLD.id OR NEW.warehouse_id<>OLD.warehouse_id OR NEW.sku_id<>OLD.sku_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'Reward source is immutable';
 END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Reward version must advance'; END IF;
 IF NEW.status<>OLD.status AND NOT ((OLD.status IN ('DRAFT','UNPUBLISHED') AND NEW.status='PUBLISHED') OR (OLD.status='PUBLISHED' AND NEW.status='UNPUBLISHED')) THEN
  RAISE EXCEPTION 'Invalid reward transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_products_protection BEFORE UPDATE OR DELETE ON reward_products FOR EACH ROW EXECUTE FUNCTION protect_reward_product();
