SET lock_timeout = '2s';
SET statement_timeout = '30s';
-- Restore the public capture table from drizzle/0000_bootstrap.sql. Existing
-- deployments retain their rows, defaults and existing insert policy.
-- Restore the bootstrap grants and RLS without replacing the table.
CREATE TABLE IF NOT EXISTS public.contact_forms (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  data jsonb DEFAULT '{}'::jsonb NOT NULL
);
ALTER TABLE public.contact_forms ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'contact_forms'
      AND policyname = 'contact_forms_insert'
  ) THEN
    CREATE POLICY contact_forms_insert ON public.contact_forms
      FOR INSERT TO anon, authenticated WITH CHECK (true);
  END IF;
END $$;
GRANT ALL ON TABLE public.contact_forms TO anon, authenticated, service_role;
