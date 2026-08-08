SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '120s';--> statement-breakpoint

CREATE TABLE "kortix"."audit_session_sequences" (
  "session_id" text PRIMARY KEY NOT NULL,
  "last_sequence" bigint DEFAULT 0 NOT NULL,
  "last_integrity_hash" varchar(64),
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "kortix"."audit_webhook_deliveries" (
  "delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "webhook_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "locked_by" text,
  "locked_until" timestamptz,
  "last_status" integer,
  "last_error" text,
  "delivered_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_delivery_webhook_fk"
    FOREIGN KEY (webhook_id) REFERENCES kortix.audit_webhooks(webhook_id) ON DELETE CASCADE,
  CONSTRAINT "audit_delivery_event_fk"
    FOREIGN KEY (event_id) REFERENCES kortix.audit_events(event_id) ON DELETE CASCADE,
  CONSTRAINT "audit_webhook_deliveries_status_check"
    CHECK (status IN ('pending', 'delivering', 'delivered', 'retry', 'dead_letter'))
);--> statement-breakpoint

ALTER TABLE "kortix"."audit_events" ADD COLUMN "opencode_session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "session_sequence" bigint;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "initiator_actor_type" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "initiator_actor_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "parent_event_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "delegation_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "authoritative_source" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "client_reported_source" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "phase" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "causation_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_ledger" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_record_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "input_summary" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "output_summary" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "input_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "output_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "integrity_previous_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "integrity_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "kortix"."tunnel_audit_logs" ADD COLUMN "phase" varchar(24) DEFAULT 'completed' NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  -- mixed-version-safe: old API versions only INSERT audit rows. Removing the
  -- account FK changes delete behavior and does not remove any column, index,
  -- or constraint referenced by an old write or ON CONFLICT statement.
  ALTER TABLE kortix.audit_events
    DROP CONSTRAINT IF EXISTS audit_events_account_id_accounts_account_id_fk;
  ALTER TABLE kortix.audit_events
    DROP CONSTRAINT IF EXISTS audit_events_account_id_fkey;
END;
$$;--> statement-breakpoint

UPDATE kortix.audit_events
SET authoritative_source = COALESCE(source, 'api')
WHERE authoritative_source IS NULL;--> statement-breakpoint

-- Existing session rows predate the sequence allocator. Rank them once so the
-- canonical session cursor can traverse the complete legacy history. The hash
-- chain starts with the first post-v2 event; legacy rows retain NULL hashes.
WITH ranked AS (
  SELECT event_id,
         row_number() OVER (
           PARTITION BY session_id
           ORDER BY occurred_at, event_id
         ) AS session_sequence
    FROM kortix.audit_events
   WHERE session_id IS NOT NULL
)
UPDATE kortix.audit_events AS event
   SET session_sequence = ranked.session_sequence
  FROM ranked
 WHERE event.event_id = ranked.event_id;--> statement-breakpoint

INSERT INTO kortix.audit_session_sequences(session_id, last_sequence)
SELECT session_id, max(session_sequence)
  FROM kortix.audit_events
 WHERE session_id IS NOT NULL
 GROUP BY session_id
ON CONFLICT (session_id) DO UPDATE
SET last_sequence = GREATEST(
  kortix.audit_session_sequences.last_sequence,
  EXCLUDED.last_sequence
);--> statement-breakpoint

CREATE UNIQUE INDEX "idx_audit_webhook_delivery_event"
  ON "kortix"."audit_webhook_deliveries" ("webhook_id", "event_id");--> statement-breakpoint
CREATE INDEX "idx_audit_webhook_delivery_due"
  ON "kortix"."audit_webhook_deliveries" ("status", "next_attempt_at", "locked_until");--> statement-breakpoint
CREATE OR REPLACE FUNCTION kortix.audit_prepare_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
DECLARE
  next_sequence bigint;
  previous_hash text;
  canonical text;
BEGIN
  NEW.authoritative_source := COALESCE(NEW.authoritative_source, NEW.source, 'api');
  NEW.source := NEW.authoritative_source;

  -- A BEFORE trigger runs before INSERT ... ON CONFLICT decides whether to
  -- discard a duplicate. Without this lock + existence check, a replayed
  -- source event advances the session sequence and hash head even though no
  -- audit row is inserted. Serialize one source identity, then skip its
  -- duplicate before touching the chain. The unique index remains the final
  -- invariant and covers writers that bypass this function in maintenance.
  IF NEW.source_ledger IS NOT NULL AND NEW.source_record_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        NEW.source_ledger || chr(31) || NEW.source_record_id || chr(31) ||
          NEW.phase || chr(31) || COALESCE(NEW.source_revision, ''),
        0
      )
    );
    IF EXISTS (
      SELECT 1
        FROM kortix.audit_events
       WHERE source_ledger = NEW.source_ledger
         AND source_record_id = NEW.source_record_id
         AND phase = NEW.phase
         AND source_revision IS NOT DISTINCT FROM NEW.source_revision
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    INSERT INTO kortix.audit_session_sequences(session_id)
    VALUES (NEW.session_id)
    ON CONFLICT (session_id) DO NOTHING;

    SELECT last_sequence + 1, last_integrity_hash
      INTO next_sequence, previous_hash
      FROM kortix.audit_session_sequences
     WHERE session_id = NEW.session_id
     FOR UPDATE;

    NEW.session_sequence := next_sequence;
    NEW.integrity_previous_hash := previous_hash;
  END IF;

  -- Cover the complete persisted event. A maintenance override can change a
  -- row, but it cannot preserve this digest without recomputing the chain.
  canonical := (to_jsonb(NEW) - 'integrity_hash')::text;
  NEW.integrity_hash := encode(extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'), 'hex');

  IF NEW.session_id IS NOT NULL THEN
    UPDATE kortix.audit_session_sequences
       SET last_sequence = next_sequence,
           last_integrity_hash = NEW.integrity_hash,
           updated_at = now()
     WHERE session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_prepare
BEFORE INSERT ON kortix.audit_events
FOR EACH ROW EXECUTE FUNCTION kortix.audit_prepare_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = kortix, public
AS $$
BEGIN
  IF current_setting('kortix.audit_maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'kortix.audit_events is append-only'
    USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON kortix.audit_events
FOR EACH ROW EXECUTE FUNCTION kortix.audit_reject_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_enqueue_webhooks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO kortix.audit_webhook_deliveries(webhook_id, event_id)
  SELECT webhook_id, NEW.event_id
    FROM kortix.audit_webhooks
   WHERE account_id = NEW.account_id
     AND enabled = true
     AND (action_prefix IS NULL OR NEW.action LIKE action_prefix || '%')
  ON CONFLICT (webhook_id, event_id) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_enqueue_webhooks
AFTER INSERT ON kortix.audit_events
FOR EACH ROW EXECUTE FUNCTION kortix.audit_enqueue_webhooks();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_connector_call()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
DECLARE
  event_phase text;
  event_outcome text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  event_phase := CASE NEW.status::text
    WHEN 'pending_approval' THEN 'pending'
    WHEN 'ok' THEN 'completed'
    WHEN 'error' THEN 'failed'
    WHEN 'denied' THEN 'denied'
    ELSE NEW.status::text END;
  event_outcome := CASE NEW.status::text
    WHEN 'pending_approval' THEN 'pending'
    WHEN 'ok' THEN 'success'
    WHEN 'denied' THEN 'denied'
    ELSE 'failure' END;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase, resource_type, resource_id,
    execution_id, source_ledger, source_record_id, source_revision,
    input_summary, input_sha256, output_summary, output_sha256, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id::text, NEW.acting_user_id,
    CASE WHEN NEW.session_id IS NULL THEN 'human' ELSE 'agent' END,
    CASE WHEN NEW.session_id IS NULL THEN 'api' ELSE 'agent' END,
    event_outcome, 'connector.' || NEW.action_path, event_phase, 'connector_call',
    NEW.execution_id::text, NEW.execution_id::text, 'connector_calls',
    NEW.execution_id::text, NEW.status::text,
    jsonb_build_object(
      'action_path', NEW.action_path,
      'risk', NEW.risk,
      'has_result_summary', NEW.result_summary IS NOT NULL,
      'has_args_preview', COALESCE(NEW.result_summary ? 'args_preview', false),
      'args_preview_complete', COALESCE(NEW.result_summary ->> 'args_preview_complete' = 'true', false)
    ),
    NEW.request_digest,
    jsonb_build_object('has_result_summary', NEW.result_summary IS NOT NULL),
    CASE WHEN NEW.result_summary IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(NEW.result_summary::text, 'UTF8'), 'sha256'), 'hex') END,
    COALESCE(NEW.resolved_at, NEW.created_at)
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER connector_calls_project_audit
AFTER INSERT OR UPDATE ON kortix.connector_calls
FOR EACH ROW EXECUTE FUNCTION kortix.audit_connector_call();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_project_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
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
      account_id, project_id, session_id, opencode_session_id, actor_user_id,
      actor_type, agent_name, initiator_actor_type, initiator_actor_id,
      delegation_depth, authoritative_source, client_reported_source, outcome,
      action, phase, resource_type, resource_id, source_ledger, source_record_id,
      source_revision, input_summary, output_sha256, occurred_at
    ) VALUES (
      NEW.account_id, NEW.project_id, NEW.session_id, NEW.opencode_session_id,
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
    account_id, project_id, session_id, opencode_session_id, actor_type,
    agent_name, authoritative_source, outcome, action, phase, resource_type,
    resource_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, output_sha256, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.opencode_session_id,
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
$$;--> statement-breakpoint

CREATE TRIGGER project_sessions_project_audit
AFTER INSERT OR UPDATE OF status ON kortix.project_sessions
FOR EACH ROW EXECUTE FUNCTION kortix.audit_project_session();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_session_lifecycle_command()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
DECLARE
  event_outcome text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts THEN RETURN NEW; END IF;
  event_outcome := CASE NEW.status::text
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'pending'
    WHEN 'succeeded' THEN 'success'
    ELSE 'failure' END;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase, resource_type, resource_id,
    execution_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, output_sha256, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.actor_user_id,
    CASE WHEN NEW.source IN ('trigger', 'schedule', 'system') THEN 'system' ELSE 'human' END,
    CASE WHEN NEW.source IN ('trigger', 'schedule') THEN 'automation' ELSE NEW.source END,
    event_outcome, 'session.lifecycle.' || NEW.command_type, NEW.status::text,
    'session_lifecycle_command', NEW.command_id::text, NEW.command_id::text,
    'session_lifecycle_commands', NEW.command_id::text,
    NEW.status::text || ':' || NEW.attempts::text,
    jsonb_build_object('command_type', NEW.command_type, 'source', NEW.source, 'attempts', NEW.attempts),
    jsonb_build_object('has_result', NEW.result IS NOT NULL, 'has_error', NEW.last_error IS NOT NULL),
    CASE WHEN NEW.result IS NULL AND NEW.last_error IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(COALESCE(NEW.result::text, NEW.last_error), 'UTF8'), 'sha256'), 'hex') END,
    COALESCE(NEW.updated_at, NEW.created_at)
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER session_lifecycle_commands_project_audit
AFTER INSERT OR UPDATE ON kortix.session_lifecycle_commands
FOR EACH ROW EXECUTE FUNCTION kortix.audit_session_lifecycle_command();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_trigger_execution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
DECLARE account_uuid uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.attempts IS NOT DISTINCT FROM OLD.attempts THEN RETURN NEW; END IF;
  SELECT account_id INTO account_uuid FROM kortix.projects WHERE project_id = NEW.project_id;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_type, authoritative_source, outcome,
    action, phase, resource_type, resource_id, execution_id, source_ledger,
    source_record_id, source_revision, input_summary, output_sha256, occurred_at
  ) VALUES (
    account_uuid, NEW.project_id, NEW.session_id, 'system', 'automation',
    CASE WHEN NEW.status IN ('completed', 'succeeded') THEN 'success'
         WHEN NEW.status IN ('failed', 'dead_lettered') THEN 'failure' ELSE 'pending' END,
    'trigger.' || NEW.slug, NEW.status, 'trigger_execution', NEW.execution_id::text,
    NEW.execution_id::text, 'project_trigger_executions', NEW.execution_id::text,
    NEW.status || ':' || NEW.attempts::text,
    jsonb_build_object('slug', NEW.slug, 'scheduled_for', NEW.scheduled_for, 'attempts', NEW.attempts),
    CASE WHEN NEW.last_error IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(NEW.last_error, 'UTF8'), 'sha256'), 'hex') END,
    COALESCE(NEW.updated_at, NEW.created_at)
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_trigger_executions_project_audit
AFTER INSERT OR UPDATE ON kortix.project_trigger_executions
FOR EACH ROW EXECUTE FUNCTION kortix.audit_trigger_execution();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_provider_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
DECLARE project_uuid uuid;
BEGIN
  SELECT project_id INTO project_uuid FROM kortix.project_sessions WHERE session_id = NEW.session_id;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_type, authoritative_source, outcome,
    action, phase, resource_type, resource_id, execution_id, source_ledger,
    source_record_id, source_revision, input_summary, output_summary,
    error_code, output_sha256, duration_ms, occurred_at
  ) VALUES (
    NEW.account_id, project_uuid, NEW.session_id, 'system', 'provider',
    CASE WHEN NEW.outcome = 'ok' THEN 'success' WHEN NEW.outcome = 'stopped' THEN 'denied' ELSE 'failure' END,
    'provider.' || NEW.kind, 'completed', 'provider_event', NEW.id::text, NEW.id::text,
    'provider_events', NEW.id::text, NEW.outcome,
    jsonb_build_object('provider', NEW.provider, 'kind', NEW.kind, 'from_provider', NEW.from_provider, 'attempts', NEW.attempts),
    jsonb_build_object('marks', NEW.marks), NEW.error_class,
    CASE WHEN NEW.error IS NULL THEN NULL ELSE
      encode(extensions.digest(convert_to(NEW.error, 'UTF8'), 'sha256'), 'hex') END,
    NEW.total_ms, NEW.created_at
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER provider_events_project_audit
AFTER INSERT ON kortix.provider_events
FOR EACH ROW EXECUTE FUNCTION kortix.audit_provider_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_usage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
BEGIN
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase, resource_type, resource_id,
    execution_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.actor_user_id,
    CASE WHEN NEW.session_id IS NULL THEN 'human' ELSE 'agent' END, 'llm_gateway',
    CASE WHEN NEW.upstream_status IS NULL OR NEW.upstream_status < 400 THEN 'success' ELSE 'failure' END,
    'llm.usage', 'completed', 'usage_event', NEW.event_id::text, NEW.event_id::text,
    'usage_events', NEW.event_id::text, COALESCE(NEW.upstream_status::text, 'ok'),
    jsonb_build_object('provider', NEW.provider, 'model', NEW.model, 'route', NEW.route, 'streaming', NEW.streaming),
    jsonb_build_object('input_tokens', NEW.input_tokens, 'output_tokens', NEW.output_tokens,
      'cached_tokens', NEW.cached_tokens, 'cache_write_tokens', NEW.cache_write_tokens,
      'cost_usd', NEW.cost_usd), NEW.created_at
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER usage_events_project_audit
AFTER INSERT ON kortix.usage_events
FOR EACH ROW EXECUTE FUNCTION kortix.audit_usage_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_gateway_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
BEGIN
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase, resource_type, resource_id,
    execution_id, request_id, source_ledger, source_record_id, source_revision,
    input_summary, output_summary, error_code, output_sha256, duration_ms, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.actor_user_id,
    CASE WHEN NEW.session_id IS NULL THEN 'human' ELSE 'agent' END, 'llm_gateway',
    CASE WHEN NEW.ok THEN 'success' ELSE 'failure' END, 'llm.request', 'completed',
    'gateway_request', NEW.log_id::text, NEW.log_id::text, NEW.request_id,
    'gateway_request_logs', NEW.log_id::text, NEW.status::text,
    jsonb_build_object('requested_model', NEW.requested_model, 'resolved_model', NEW.resolved_model,
      'provider', NEW.provider, 'streaming', NEW.streaming, 'attempts', NEW.attempts),
    jsonb_build_object('status', NEW.status, 'input_tokens', NEW.input_tokens,
      'output_tokens', NEW.output_tokens, 'final_cost', NEW.final_cost),
    NEW.error_code,
    CASE WHEN NEW.error_message IS NULL THEN NULL
         WHEN NEW.error_message ~ '^sha256:[0-9a-f]{64}$' THEN substring(NEW.error_message FROM 8)
         ELSE encode(extensions.digest(convert_to(NEW.error_message, 'UTF8'), 'sha256'), 'hex') END,
    NEW.latency_ms, NEW.created_at
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER gateway_request_logs_project_audit
AFTER INSERT ON kortix.gateway_request_logs
FOR EACH ROW EXECUTE FUNCTION kortix.audit_gateway_request();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_voice_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
DECLARE account_uuid uuid;
BEGIN
  SELECT account_id INTO account_uuid FROM kortix.projects WHERE project_id = NEW.project_id;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_type, authoritative_source, outcome,
    action, phase, resource_type, resource_id, message_id, source_ledger,
    source_record_id, source_revision, input_summary, input_sha256, occurred_at
  ) VALUES (
    account_uuid, NEW.project_id, NEW.session_id,
    CASE WHEN NEW.role = 'user' THEN 'human' ELSE 'agent' END, 'voice', 'success',
    'voice.turn.' || NEW.role, 'completed', 'voice_turn', NEW.cursor::text,
    NEW.cursor::text, 'voice_call_turns', NEW.cursor::text, NEW.role,
    jsonb_build_object('call_id', NEW.call_id, 'role', NEW.role, 'speaker', NEW.speaker,
      'character_count', length(NEW.text)),
    encode(extensions.digest(convert_to(NEW.text, 'UTF8'), 'sha256'), 'hex'), NEW.created_at
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER voice_call_turns_project_audit
AFTER INSERT ON kortix.voice_call_turns
FOR EACH ROW EXECUTE FUNCTION kortix.audit_voice_turn();--> statement-breakpoint

CREATE OR REPLACE FUNCTION kortix.audit_tunnel_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.phase IS NOT DISTINCT FROM OLD.phase THEN RETURN NEW; END IF;
  INSERT INTO kortix.audit_events(
    account_id, project_id, session_id, actor_user_id, actor_type,
    authoritative_source, outcome, action, phase,
    resource_type, resource_id, execution_id, source_ledger, source_record_id,
    source_revision, input_summary, output_summary, output_sha256, duration_ms, occurred_at
  ) VALUES (
    NEW.account_id, NEW.project_id, NEW.session_id, NEW.actor_user_id,
    COALESCE(NEW.actor_type, CASE WHEN NEW.actor_user_id IS NULL THEN 'system' ELSE 'human' END),
    'computer', CASE WHEN NEW.phase = 'started' THEN 'pending'
                     WHEN NEW.success THEN 'success' ELSE 'failure' END,
    'computer.' || NEW.operation, NEW.phase, 'computer_tunnel', NEW.tunnel_id::text,
    NEW.log_id::text, 'tunnel_audit_logs', NEW.log_id::text, NEW.phase,
    jsonb_build_object(
      'method', NEW.request_summary ->> 'method',
      'has_path', NEW.request_summary ? 'path',
      'has_command', NEW.request_summary ? 'command',
      'has_cwd', NEW.request_summary ? 'cwd',
      'argument_count', COALESCE((NEW.request_summary ->> 'argumentCount')::integer, 0),
      'content_size', COALESCE((NEW.request_summary ->> 'contentSize')::integer, 0)
    ), jsonb_build_object('capability', NEW.capability,
      'bytes_transferred', NEW.bytes_transferred),
    CASE WHEN NEW.error_message IS NULL THEN NULL
         WHEN NEW.error_message ~ '^sha256:[0-9a-f]{64}$' THEN substring(NEW.error_message FROM 8)
         ELSE encode(extensions.digest(convert_to(NEW.error_message, 'UTF8'), 'sha256'), 'hex') END,
    NEW.duration_ms,
    CASE WHEN NEW.phase = 'started' OR NEW.duration_ms IS NULL THEN NEW.created_at
         ELSE NEW.created_at + (NEW.duration_ms * interval '1 millisecond') END
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tunnel_audit_logs_project_audit
AFTER INSERT OR UPDATE OF phase ON kortix.tunnel_audit_logs
FOR EACH ROW EXECUTE FUNCTION kortix.audit_tunnel_operation();
