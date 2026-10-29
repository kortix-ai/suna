-- Migration: connector_call_approved_audit_outcome
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The connector_calls audit projection (kortix.audit_connector_call) mapped
-- every status it did not name to outcome 'failure'. Approve now flips a gate
-- that held its input to 'approved' (20261029175000000): a person approved it,
-- so the projected row carries outcome 'success', as an approved 'ok' gate
-- did. Phase stays the status text ('approved'). The held run writes its own
-- connector_calls row with its own outcome.
-- apps/api/src/shared/audit-reconciliation.ts reconstructs the same row with
-- the same mapping, so both writers agree on (phase, source_revision).
-- CREATE OR REPLACE FUNCTION locks the function, not the table. Old code never
-- writes 'approved', so it cannot observe the difference.

CREATE OR REPLACE FUNCTION kortix.audit_connector_call()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kortix', 'public'
AS $function$
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
    WHEN 'expired' THEN 'expired'
    WHEN 'approved' THEN 'success'
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
$function$;
