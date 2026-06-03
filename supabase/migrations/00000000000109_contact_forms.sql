-- Generic contact / lead form capture. Deliberately schema-agnostic: the whole
-- submission lands in a single JSONB blob, so changing a form's fields never
-- needs a migration. Used by the public /contact qualifier, reusable by any
-- other form.
--
-- RLS: public forms write as the anon role, so allow INSERT for
-- anon + authenticated but NO SELECT (read only via the service role / SQL
-- console). Idempotent so ensureSchema can re-run it.
CREATE TABLE IF NOT EXISTS public.contact_forms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.contact_forms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_forms_insert ON public.contact_forms;
CREATE POLICY contact_forms_insert ON public.contact_forms
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

GRANT INSERT ON public.contact_forms TO anon, authenticated;
