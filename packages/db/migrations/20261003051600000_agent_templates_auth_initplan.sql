-- Evaluate the legacy template policies' statement-constant JWT once per query.
-- Preserve policy commands, roles, permissiveness, and implicit UPDATE checks.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
             AND policyname = 'Users can create their own templates') THEN
    ALTER POLICY "Users can create their own templates" ON public.agent_templates
      WITH CHECK (creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
             AND policyname = 'Users can delete their own templates') THEN
    ALTER POLICY "Users can delete their own templates" ON public.agent_templates
      USING (creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
             AND policyname = 'Users can update their own templates') THEN
    ALTER POLICY "Users can update their own templates" ON public.agent_templates
      USING (creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
             AND policyname = 'Users can view public templates or their own templates') THEN
    ALTER POLICY "Users can view public templates or their own templates" ON public.agent_templates
      USING (is_public = true OR creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
END
$$;
