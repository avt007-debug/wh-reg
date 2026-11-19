-- Employee dashboard attendance: the day came back as a timestamp, so the app could not tell the weekday
-- (Sundays and today showed "Absent"). Each day now also says whether it was a day off, approved leave,
-- or closed automatically because the employee forgot to clock out.
DO $$
DECLARE def text := pg_get_functiondef('public.my_dashboard(date)'::regprocedure);
BEGIN
  IF position('''date'', d.d, ''first_in''' IN def) = 0 OR position('count(*) AS shifts,' IN def) = 0 THEN
    RAISE EXCEPTION 'my_dashboard patch target missing';
  END IF;
  def := replace(def, '''date'', d.d, ''first_in''',
    '''date'', d.d::date, ''auto'', coalesce(x.auto, false),
               ''off'', NOT coalesce((app.setting(''notifications'')->''work_days'') @> to_jsonb(extract(isodow FROM d.d)::int), true),
               ''leave'', EXISTS (SELECT 1 FROM leave_days l WHERE l.user_id = v_uid AND l.leave_date = d.d::date AND l.status = ''APPROVED''),
               ''first_in''');
  def := replace(def, 'count(*) AS shifts,', 'count(*) AS shifts, bool_or(a.auto_closed) AS auto,');
  EXECUTE def;
END$$;
