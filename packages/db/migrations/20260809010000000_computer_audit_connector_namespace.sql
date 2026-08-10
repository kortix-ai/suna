-- Computer operations are connector calls. Keep the tunnel ledger as the
-- durable source, but emit new centralized audit rows in the connector
-- namespace so grants, policies, and audit filters use one domain model.
set lock_timeout = '2s';
set statement_timeout = '30s';

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
    'connector', CASE WHEN NEW.phase = 'started' THEN 'pending'
                      WHEN NEW.success THEN 'success' ELSE 'failure' END,
    'connector.computer.' || NEW.operation, NEW.phase, 'computer_tunnel', NEW.tunnel_id::text,
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
$$;
