-- Migration: runtime_names
--
-- Every session runs pi. Nine columns still carried OpenCode names, though pi
-- writes them and the code already calls them by neutral names
-- (`runtimeSessionId`, `harnessVersion`, `model` in kortix.ts):
--
--   opencode_session_id -> runtime_session_id   project_sessions, session_turns,
--                                                session_runtime_projections,
--                                                session_pending_questions,
--                                                audit_events (+ its partitions),
--                                                audit_events_legacy
--   opencode_version    -> harness_version      session_runtime_projections
--   opencode_model      -> model                chat_channel_bindings
--
-- A rename changes only the catalog: no row is rewritten (audit_events_legacy
-- is 199 GB on prod). Two objects name a column in text and are fixed here,
-- in the same transaction:
--   - the trigger function kortix.audit_project_session() (fires on every
--     project_sessions insert and status change) is recreated with the new
--     name; its body is otherwise the one prod and dev run (checked
--     2026-11-05);
--   - the view kortix.audit_events_all keeps a column's old name after the
--     table's rename, so its column is renamed too.
-- No index, constraint, policy or other function names these columns
-- (catalog read on prod and dev, 2026-11-05).
--
-- Lock order: project_sessions first and audit_events after it, the order the
-- trigger takes them, so a session write in flight cannot deadlock with this
-- migration. Each lock waits at most 2 s; a 55P03 rolls the batch back and the
-- deploy job is re-run (learnings 2026-09-25: never raise the timeout).
--
-- mixed-version-safe: NOT safe, by decision. The previous API version names
-- the old columns, so its tasks fail every query on these tables from this
-- commit until the rollout replaces them (about 12 min on the v0.14.19 prod
-- deploy: migrations done 13:18:56Z, API web stable 13:31:12Z). The owner
-- accepted that downtime on 2026-11-05 instead of a two-release
-- expand/contract. Self-host runs one process that migrates before it serves,
-- so it has no such window.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- squawk-ignore renaming-column
ALTER TABLE "kortix"."project_sessions" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."session_turns" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."session_runtime_projections" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."session_runtime_projections" RENAME COLUMN "opencode_version" TO "harness_version";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."session_pending_questions" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."chat_channel_bindings" RENAME COLUMN "opencode_model" TO "model";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."audit_events" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
-- squawk-ignore renaming-column
ALTER TABLE IF EXISTS "kortix"."audit_events_legacy" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
ALTER VIEW "kortix"."audit_events_all" RENAME COLUMN "opencode_session_id" TO "runtime_session_id";--> statement-breakpoint
CREATE OR REPLACE FUNCTION kortix.audit_project_session()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kortix', 'public', 'extensions'
AS $function$
DECLARE
  event_source text;
  event_actor_type text;
  event_outcome text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_source := CASE NEW.origin::text
      WHEN 'trigger' THEN 'automation'
      WHEN 'schedule' THEN 'automation'
      WHEN 'backend' THEN 'api'
      WHEN 'system' THEN 'system'
      ELSE 'human' END;
    event_actor_type := CASE NEW.origin::text
      WHEN 'trigger' THEN 'system'
      WHEN 'schedule' THEN 'system'
      WHEN 'system' THEN 'system'
      ELSE 'human' END;
    event_source := COALESCE(
      NULLIF(NEW.metadata #>> '{audit_v2,authoritative_source}', ''),
      event_source
    );
    event_actor_type := COALESCE(
      NULLIF(NEW.metadata #>> '{audit_v2,actor_type}', ''),
      event_actor_type
    );
    INSERT INTO kortix.audit_events(
      account_id, project_id, session_id, runtime_session_id, actor_user_id,
      actor_type, agent_name, initiator_actor_type, initiator_actor_id,
      delegation_depth, authoritative_source, client_reported_source, outcome,
      action, phase, resource_type, resource_id, source_ledger, source_record_id,
      source_revision, input_summary, output_sha256, occurred_at
    ) VALUES (
      NEW.account_id, NEW.project_id, NEW.session_id, NEW.runtime_session_id,
      NEW.created_by, event_actor_type, NEW.agent_name,
      NULLIF(NEW.metadata #>> '{audit_v2,initiator_actor_type}', ''),
      NULLIF(NEW.metadata #>> '{audit_v2,initiator_actor_id}', ''),
      COALESCE((NEW.metadata #>> '{audit_v2,delegation_depth}')::integer, 0),
      event_source,
      NULLIF(NEW.metadata #>> '{audit_v2,client_reported_source}', ''), 'success',
      'session.created', 'created', 'project_session', NEW.session_id,
      'project_sessions', NEW.session_id, 'created',
      jsonb_build_object(
        'origin', NEW.origin,
        'agent_name', NEW.agent_name,
        'visibility', NEW.visibility,
        'sandbox_provider', NEW.sandbox_provider,
        'required_connector_count', CASE
          WHEN jsonb_typeof(NEW.required_connectors) = 'array'
          THEN jsonb_array_length(NEW.required_connectors) ELSE 0 END,
        'secret_allowlist_count', CASE
          WHEN jsonb_typeof(NEW.secrets_allowlist) = 'array'
          THEN jsonb_array_length(NEW.secrets_allowlist) ELSE 0 END,
        'connector_bindings_configured', NEW.connector_bindings_configured
      ),
      CASE WHEN NEW.error IS NULL THEN NULL ELSE
        encode(extensions.digest(convert_to(NEW.error, 'UTF8'), 'sha256'), 'hex') END,
      NEW.created_at
    ) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  event_outcome := CASE NEW.status::text
    WHEN 'queued' THEN 'pending'
    WHEN 'branching' THEN 'pending'
    WHEN 'provisioning' THEN 'pending'
    WHEN 'running' THEN 'success'
    WHEN 'stopped' THEN 'success'
    ELSE 'failure' END;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, runtime_session_id, actor_type,
    agent_name, authoritative_source, outcome, action, phase, resource_type,
    resource_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, output_sha256, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.runtime_session_id,
    'system', NEW.agent_name, 'system', event_outcome, 'session.status.changed',
    NEW.status::text, 'project_session', NEW.session_id, 'project_sessions',
    NEW.session_id, gen_random_uuid()::text,
    jsonb_build_object('from_status', OLD.status, 'to_status', NEW.status),
    jsonb_build_object('has_error', NEW.error IS NOT NULL),
    CASE WHEN NEW.error IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(NEW.error, 'UTF8'), 'sha256'), 'hex') END,
    COALESCE(NEW.updated_at, now())
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;
