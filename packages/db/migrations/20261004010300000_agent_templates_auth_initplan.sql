-- Evaluate the legacy template policies' statement-constant JWT once per query.
-- Preserve policy commands, roles, and permissiveness. The UPDATE policy's
-- WITH CHECK is restated so both shapes stay InitPlan'd: ALTER POLICY keeps a
-- clause it is not given, and a policy carrying a stored WITH CHECK would keep
-- re-evaluating auth.jwt() per row on the write side. The live catalog's update
-- policy is implicit today (with_check is NULL), where the rewritten USING
-- already covers the write side; the restatement is defensive, not a repair.
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
      USING (creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid)
      WITH CHECK (creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
             AND policyname = 'Users can view public templates or their own templates') THEN
    ALTER POLICY "Users can view public templates or their own templates" ON public.agent_templates
      USING (is_public = true OR creator_id = ((SELECT auth.jwt()) ->> 'sub')::uuid);
  END IF;
END
$$;
