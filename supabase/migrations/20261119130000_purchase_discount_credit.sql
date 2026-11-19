-- Discount received on a purchase → credit note (owner only)
--
-- After a purchase is approved the owner lists its items and enters the discount the
-- seller gave on each one: a % off, a ₹ amount off the line, or the discounted rate per
-- unit (before GST). For every item
--     discounted value = value before GST − discount
-- and for the bill
--     credit note = total value of all items before GST − total discounted value.
-- The credit note is kept for future purchases from that seller (as before); it is not
-- deducted from this bill.
--
-- A credit line is now stored either as a % (credit_pct) or as a ₹ amount (credit_amount).
-- "Discounted rate" is saved as the ₹ amount it works out to, plus the rate for display.

ALTER TABLE fin.purchase_credit_notes ALTER COLUMN credit_pct DROP NOT NULL;
ALTER TABLE fin.purchase_credit_notes DROP CONSTRAINT IF EXISTS purchase_credit_notes_credit_pct_check;
ALTER TABLE fin.purchase_credit_notes
  ADD CONSTRAINT purchase_credit_notes_credit_pct_check CHECK (credit_pct IS NULL OR (credit_pct > 0 AND credit_pct <= 100)),
  ADD COLUMN credit_amount numeric(14,2) CHECK (credit_amount IS NULL OR credit_amount > 0),
  ADD COLUMN discounted_rate numeric(14,4) CHECK (discounted_rate IS NULL OR discounted_rate >= 0),
  ADD CONSTRAINT purchase_credit_notes_one_kind CHECK (num_nonnulls(credit_pct, credit_amount) = 1);

-- ₹ value of one credit line (never more than the line's value before GST)
CREATE FUNCTION fin.credit_value(p_taxable numeric, p_pct numeric, p_amount numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(round(CASE WHEN p_amount IS NOT NULL THEN least(p_amount, greatest(p_taxable, 0))
                             ELSE p_taxable * p_pct / 100 END, 2), 0)
$$;

-- Every reader of credit notes uses the new value function.
DO $$
DECLARE f text; def text;
  old_val constant text := 'round(pi.line_taxable * cn.credit_pct / 100, 2)';
  new_val constant text := 'fin.credit_value(pi.line_taxable, cn.credit_pct, cn.credit_amount)';
BEGIN
  -- purchase detail: also return the amount / rate the credit was entered as
  def := pg_get_functiondef('fin.purchase_detail(uuid)'::regprocedure);
  IF position(old_val IN def) = 0 OR position('''credit_pct'', cn.credit_pct,' IN def) = 0 THEN
    RAISE EXCEPTION 'purchase_detail patch target missing';
  END IF;
  def := replace(def, '''credit_pct'', cn.credit_pct,',
                 '''credit_pct'', cn.credit_pct, ''credit_amount'', cn.credit_amount, ''discounted_rate'', cn.discounted_rate,');
  EXECUTE replace(def, old_val, new_val);

  -- credit summary: average % is worked out from the value, since a line may be a ₹ amount
  def := pg_get_functiondef('public.owner_credit_summary(uuid)'::regprocedure);
  IF position(old_val || ' AS value, pi.qty_base, cn.credit_pct' IN def) = 0 THEN
    RAISE EXCEPTION 'owner_credit_summary patch target missing';
  END IF;
  def := replace(def, old_val || ' AS value, pi.qty_base, cn.credit_pct',
                 new_val || ' AS value, pi.qty_base, round(' || new_val || ' * 100 / nullif(pi.line_taxable, 0), 2) AS credit_pct');
  EXECUTE def;

  FOREACH f IN ARRAY ARRAY['public.owner_use_credit(jsonb)'] LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position(old_val IN def) = 0 THEN RAISE EXCEPTION '% patch target missing', f; END IF;
    EXECUTE replace(def, old_val, new_val);
  END LOOP;

  -- setting a % replaces any ₹ amount on that line
  def := pg_get_functiondef('public.owner_set_purchase_credits(uuid,jsonb,numeric)'::regprocedure);
  IF position('DO UPDATE SET credit_pct = EXCLUDED.credit_pct,' IN def) = 0 THEN
    RAISE EXCEPTION 'owner_set_purchase_credits patch target missing';
  END IF;
  EXECUTE replace(def, 'DO UPDATE SET credit_pct = EXCLUDED.credit_pct,',
                  'DO UPDATE SET credit_pct = EXCLUDED.credit_pct, credit_amount = NULL, discounted_rate = NULL,');

  -- editing a bill's items keeps ₹ / rate credits too
  def := pg_get_functiondef('public.owner_update_purchase(uuid,jsonb)'::regprocedure);
  IF position('INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, entered_by)
    SELECT pi.id, (e.j->>''creditPct'')::numeric, app.current_user_id()' IN def) = 0
     OR position('WHERE coalesce(nullif(e.j->>''creditPct'', '''')::numeric, 0) > 0;' IN def) = 0 THEN
    RAISE EXCEPTION 'owner_update_purchase patch target missing';
  END IF;
  def := replace(def, 'INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, entered_by)
    SELECT pi.id, (e.j->>''creditPct'')::numeric, app.current_user_id()',
    'INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, credit_amount, discounted_rate, entered_by)
    SELECT pi.id,
           CASE WHEN coalesce(nullif(e.j->>''creditAmount'', '''')::numeric, 0) > 0 THEN NULL ELSE (e.j->>''creditPct'')::numeric END,
           nullif(nullif(e.j->>''creditAmount'', '''')::numeric, 0),
           CASE WHEN coalesce(nullif(e.j->>''creditAmount'', '''')::numeric, 0) > 0 THEN nullif(e.j->>''discountedRate'', '''')::numeric END,
           app.current_user_id()');
  EXECUTE replace(def, 'WHERE coalesce(nullif(e.j->>''creditPct'', '''')::numeric, 0) > 0;',
    'WHERE coalesce(nullif(e.j->>''creditPct'', '''')::numeric, 0) > 0 OR coalesce(nullif(e.j->>''creditAmount'', '''')::numeric, 0) > 0;');
END$$;

/* Discount received per item → credit note.
   p_lines = [{ itemId, mode: 'PERCENT' | 'AMOUNT' | 'RATE', value }]
     PERCENT: value = % off the line's value before GST
     AMOUNT : value = ₹ off the whole line (before GST)
     RATE   : value = discounted rate per unit before GST → credit = value before GST − qty × rate
   A value of 0 / empty clears the line. Lines not listed are left as they are. */
CREATE FUNCTION public.owner_set_purchase_discounts_received(p_purchase uuid, p_lines jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE e jsonb; pi purchase_items; v_status text; v_mode text; v_val numeric; v_amt numeric; v_rate numeric;
BEGIN
  PERFORM app.require_full_owner();
  SELECT status INTO v_status FROM purchases WHERE id = p_purchase;
  IF v_status IS NULL OR v_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Purchase not found or cancelled' USING ERRCODE = 'WH005';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
    SELECT * INTO pi FROM purchase_items WHERE id = (e->>'itemId')::uuid AND purchase_id = p_purchase;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item is not on this purchase' USING ERRCODE = 'WH005'; END IF;
    v_mode := upper(coalesce(e->>'mode', 'PERCENT'));
    v_val  := nullif(e->>'value', '')::numeric;
    v_rate := NULL;

    IF v_val IS NULL OR (v_val = 0 AND v_mode <> 'RATE') THEN
      DELETE FROM fin.purchase_credit_notes WHERE purchase_item_id = pi.id;
      CONTINUE;
    END IF;
    IF v_val < 0 THEN RAISE EXCEPTION 'Discount cannot be negative' USING ERRCODE = 'WH005'; END IF;

    IF v_mode = 'PERCENT' THEN
      IF v_val > 100 THEN RAISE EXCEPTION 'Discount %% must be between 0 and 100' USING ERRCODE = 'WH005'; END IF;
      INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, credit_amount, discounted_rate, entered_by)
      VALUES (pi.id, v_val, NULL, NULL, app.current_user_id())
      ON CONFLICT (purchase_item_id) DO UPDATE SET credit_pct = EXCLUDED.credit_pct, credit_amount = NULL, discounted_rate = NULL,
                                                  entered_by = EXCLUDED.entered_by, entered_at = now();
      CONTINUE;
    ELSIF v_mode = 'AMOUNT' THEN
      v_amt := round(v_val, 2);
    ELSIF v_mode = 'RATE' THEN
      v_rate := v_val;
      v_amt := round(pi.line_taxable - round(pi.qty * v_val, 2), 2);
      IF v_amt < 0 THEN
        RAISE EXCEPTION 'Discounted rate ₹% is more than the billed rate for %', v_val,
          (SELECT name FROM products WHERE id = pi.product_id) USING ERRCODE = 'WH005';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unknown discount type %', v_mode USING ERRCODE = 'WH005';
    END IF;

    IF v_amt > pi.line_taxable THEN
      RAISE EXCEPTION 'Discount ₹% is more than the item value ₹% before GST', v_amt, pi.line_taxable USING ERRCODE = 'WH005';
    END IF;
    IF v_amt = 0 THEN
      DELETE FROM fin.purchase_credit_notes WHERE purchase_item_id = pi.id;
    ELSE
      INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, credit_amount, discounted_rate, entered_by)
      VALUES (pi.id, NULL, v_amt, v_rate, app.current_user_id())
      ON CONFLICT (purchase_item_id) DO UPDATE SET credit_pct = NULL, credit_amount = EXCLUDED.credit_amount,
                                                  discounted_rate = EXCLUDED.discounted_rate,
                                                  entered_by = EXCLUDED.entered_by, entered_at = now();
    END IF;
  END LOOP;
  RETURN fin.purchase_detail(p_purchase);
END$$;
REVOKE EXECUTE ON FUNCTION public.owner_set_purchase_discounts_received(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_set_purchase_discounts_received(uuid, jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION fin.credit_value(numeric, numeric, numeric) FROM PUBLIC, anon;
