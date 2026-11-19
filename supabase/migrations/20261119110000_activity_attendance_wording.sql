-- Activity log: automatic clock-outs say so; an employee's own clock-in / clock-out is not listed twice
-- (once as "Clocked out" and again as "Attendance changed"). Owner corrections still show.
DO $$
DECLARE def text := pg_get_functiondef('public.owner_activity(int,timestamptz,uuid)'::regprocedure);
BEGIN
  IF position('SELECT a.clock_out_at, a.user_id, ''CLOCK'', ''Clocked out'' FROM attendance a' IN def) = 0
     OR position('AND a.action <> ''INSERT''' IN def) = 0 THEN
    RAISE EXCEPTION 'owner_activity patch target missing';
  END IF;
  def := replace(def, 'SELECT a.clock_out_at, a.user_id, ''CLOCK'', ''Clocked out'' FROM attendance a',
    'SELECT a.clock_out_at, a.user_id, ''CLOCK'', CASE WHEN a.auto_closed THEN ''Clocked out automatically (forgot to clock out)'' ELSE ''Clocked out'' END FROM attendance a');
  def := replace(def, 'AND a.action <> ''INSERT''',
    'AND a.action <> ''INSERT''
          AND NOT (a.table_name = ''public.attendance'' AND (a.actor_id::text = a.new_data->>''user_id'' OR a.new_data->>''auto_closed'' = ''true''))');
  EXECUTE def;
END$$;
