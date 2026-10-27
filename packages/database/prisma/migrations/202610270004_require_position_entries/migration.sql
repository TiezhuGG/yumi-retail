BEGIN;
-- A zero-delta move must still have actual position facts, not an empty header.
CREATE OR REPLACE FUNCTION yumi_verify_position_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id uuid; main_row record; total record;
BEGIN
  IF TG_TABLE_NAME='stock_ledger' THEN event_id:=NEW.id; ELSE event_id:=NEW.stock_ledger_id; END IF;
  SELECT delta_on_hand h,delta_reserved r,delta_blocked x INTO main_row FROM stock_ledger WHERE id=event_id;
  SELECT COUNT(*) n,COALESCE(SUM(delta_on_hand),0) h,COALESCE(SUM(delta_reserved),0) r,COALESCE(SUM(delta_blocked),0) x INTO total FROM position_ledger WHERE stock_ledger_id=event_id;
  IF total.n=0 OR ROW(main_row.h,main_row.r,main_row.x) IS DISTINCT FROM ROW(total.h,total.r,total.x) THEN
    RAISE EXCEPTION 'Inventory event must have balanced position entries';
  END IF;
  RETURN NULL;
END $$;
COMMIT;
