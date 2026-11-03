-- Keep public capture rows inert unless written by a trusted server role.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.enqueue_demo_requested() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- Unknown form kinds fail closed; career/application rows never reach Sales.
  IF coalesce(NEW.data->>'form', 'contact') IN ('demo', 'contact')
     AND coalesce(NEW.data->>'source', '') NOT LIKE 'careers%'
     AND NOT (NEW.data ? 'opening') THEN
    INSERT INTO kortix.sales_event_outbox(event_id, payload)
    VALUES ('demo.requested:' || NEW.id, jsonb_build_object(
      'schema_version', 1, 'event_id', 'demo.requested:' || NEW.id,
      'type', 'demo.requested', 'occurred_at', NEW.created_at,
      'data', jsonb_build_object('submission_id', NEW.id, 'email', NEW.data->>'email',
        'name', NEW.data->>'name', 'source', 'demo', 'form_type', 'demo',
        'created_at', NEW.created_at, 'company_name', NEW.data->>'company_name')))
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
