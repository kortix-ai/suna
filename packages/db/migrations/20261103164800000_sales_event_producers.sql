-- Transactional producers: confirmation and contact persistence never dispatch HTTP.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.sales_event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kortix.sales_event_outbox FROM anon, authenticated;

CREATE FUNCTION kortix.enqueue_confirmed_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL AND NEW.email IS NOT NULL THEN
    INSERT INTO kortix.sales_event_outbox(event_id, payload)
    VALUES ('account.signup:' || NEW.id, jsonb_build_object(
      'schema_version', 1, 'event_id', 'account.signup:' || NEW.id,
      'type', 'account.signup', 'occurred_at', NEW.email_confirmed_at,
      'data', jsonb_build_object('user_id', NEW.id, 'email', NEW.email,
        'name', coalesce(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        'provider', NEW.raw_app_meta_data->>'provider',
        'email_confirmed_at', NEW.email_confirmed_at,
        'created_at', NEW.created_at, 'auth_created_at', NEW.created_at,
        'email_domain', lower(split_part(NEW.email, '@', 2)), 'source', 'signup')))
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
-- Every Supabase auth.users has email_confirmed_at. The migration tests build a stub
-- auth.users (id only) and run this whole chain against it; there the trigger is skipped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'email_confirmed_at'
  ) THEN
    CREATE TRIGGER sales_signup_confirmed AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
    FOR EACH ROW EXECUTE FUNCTION kortix.enqueue_confirmed_signup();
  END IF;
END;
$$;

CREATE FUNCTION kortix.enqueue_demo_requested() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
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
-- public.contact_forms exists on every hosted database (packages/db/drizzle/0000_bootstrap.sql,
-- applied outside this chain) but not on a database built from migrations alone (the DB test
-- template, a fresh local stack). Create it there with the bootstrap's exact shape; elsewhere
-- every statement below is a no-op.
CREATE TABLE IF NOT EXISTS public.contact_forms (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  data jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.contact_forms ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contact_forms' AND policyname = 'contact_forms_insert') THEN
    CREATE POLICY contact_forms_insert ON public.contact_forms FOR INSERT TO anon, authenticated WITH CHECK (true);
  END IF;
END;
$$;
GRANT ALL ON TABLE public.contact_forms TO anon, authenticated, service_role;
CREATE TRIGGER sales_demo_requested AFTER INSERT ON public.contact_forms
FOR EACH ROW EXECUTE FUNCTION kortix.enqueue_demo_requested();
