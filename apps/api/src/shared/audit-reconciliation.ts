import { sql } from 'drizzle-orm';
import { auditDb } from './audit-db';

export interface AuditReconciliationResult {
  inserted: number;
  complete: boolean;
  by_source: Record<string, number>;
}

/**
 * Project durable source ledgers that predate the canonical triggers.
 *
 * The query selects only missing `(source_ledger, source_record_id, phase)`
 * tuples. Repeated calls are idempotent and resumable. A bounded page prevents
 * one old account from holding an API transaction for the full history.
 */
export async function reconcileAuditEvents(
  accountId: string,
  limit = 1_000,
): Promise<AuditReconciliationResult> {
  const rows = await auditDb().execute<{ sourceLedger: string }>(sql`
    WITH candidates AS (
      SELECT c.account_id, c.project_id, c.session_id::text AS session_id,
             NULL::text AS opencode_session_id, c.acting_user_id AS actor_user_id,
             CASE WHEN c.session_id IS NULL THEN 'human' ELSE 'agent' END AS actor_type,
             NULL::text AS agent_name, NULL::text AS initiator_actor_type,
             NULL::text AS initiator_actor_id, 0::integer AS delegation_depth,
             CASE WHEN c.session_id IS NULL THEN 'api' ELSE 'agent' END AS authoritative_source,
             NULL::text AS client_reported_source,
             CASE c.status::text WHEN 'pending_approval' THEN 'pending' WHEN 'ok' THEN 'success'
                  WHEN 'denied' THEN 'denied' ELSE 'failure' END AS outcome,
             'connector.' || c.action_path AS action,
             CASE c.status::text WHEN 'pending_approval' THEN 'pending' WHEN 'ok' THEN 'completed'
                  WHEN 'error' THEN 'failed' WHEN 'denied' THEN 'denied' ELSE c.status::text END AS phase,
             'connector_call' AS resource_type, c.execution_id::text AS resource_id,
             c.execution_id::text AS execution_id, NULL::text AS message_id, NULL::text AS request_id,
             'connector_calls' AS source_ledger, c.execution_id::text AS source_record_id,
             c.status::text AS source_revision,
             jsonb_build_object(
               'action_path', c.action_path,
               'risk', c.risk,
               'has_args_preview', COALESCE(c.result_summary ? 'args_preview', false),
               'args_preview_complete', COALESCE(c.result_summary ->> 'args_preview_complete' = 'true', false)
             ) AS input_summary,
             c.request_digest AS input_sha256,
             jsonb_build_object('has_result_summary', c.result_summary IS NOT NULL) AS output_summary,
             CASE WHEN c.result_summary IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(c.result_summary::text, 'UTF8'), 'sha256'), 'hex') END AS output_sha256,
             NULL::integer AS duration_ms, COALESCE(c.resolved_at, c.created_at) AS occurred_at
        FROM kortix.connector_calls c WHERE c.account_id = ${accountId}::uuid
      UNION ALL
      SELECT s.account_id, s.project_id, s.session_id, s.opencode_session_id, s.created_by,
             COALESCE(
               NULLIF(s.metadata #>> '{audit_v2,actor_type}', ''),
               CASE s.origin::text WHEN 'trigger' THEN 'system' WHEN 'schedule' THEN 'system'
                    WHEN 'system' THEN 'system' ELSE 'human' END
             ),
             s.agent_name,
             NULLIF(s.metadata #>> '{audit_v2,initiator_actor_type}', ''),
             NULLIF(s.metadata #>> '{audit_v2,initiator_actor_id}', ''),
             COALESCE((s.metadata #>> '{audit_v2,delegation_depth}')::integer, 0),
             COALESCE(
               NULLIF(s.metadata #>> '{audit_v2,authoritative_source}', ''),
               CASE s.origin::text WHEN 'trigger' THEN 'automation' WHEN 'schedule' THEN 'automation'
                    WHEN 'backend' THEN 'api' WHEN 'system' THEN 'system' ELSE 'human' END
             ),
             NULLIF(s.metadata #>> '{audit_v2,client_reported_source}', ''),
             'success', 'session.created', 'created', 'project_session', s.session_id,
             s.session_id, NULL::text, NULL::text, 'project_sessions', s.session_id, 'created',
             jsonb_build_object(
               'origin', s.origin,
               'agent_name', s.agent_name,
               'visibility', s.visibility,
               'sandbox_provider', s.sandbox_provider,
               'required_connector_count', CASE
                 WHEN jsonb_typeof(s.required_connectors) = 'array'
                 THEN jsonb_array_length(s.required_connectors) ELSE 0 END,
               'secret_allowlist_count', CASE
                 WHEN jsonb_typeof(s.secrets_allowlist) = 'array'
                 THEN jsonb_array_length(s.secrets_allowlist) ELSE 0 END,
               'connector_bindings_configured', s.connector_bindings_configured
             ), NULL::text, NULL::jsonb,
             CASE WHEN s.error IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(s.error, 'UTF8'), 'sha256'), 'hex') END,
             NULL::integer, s.created_at
        FROM kortix.project_sessions s WHERE s.account_id = ${accountId}::uuid
      UNION ALL
      SELECT l.account_id, l.project_id, l.session_id, NULL::text, l.actor_user_id,
             CASE WHEN l.source IN ('trigger','schedule','system') THEN 'system' ELSE 'human' END,
             NULL::text, NULL::text, NULL::text, 0::integer,
             CASE WHEN l.source IN ('trigger','schedule') THEN 'automation' ELSE l.source END,
             NULL::text,
             CASE l.status::text WHEN 'queued' THEN 'pending' WHEN 'running' THEN 'pending'
                  WHEN 'succeeded' THEN 'success' ELSE 'failure' END,
             'session.lifecycle.' || l.command_type, l.status::text,
             'session_lifecycle_command', l.command_id::text, l.command_id::text,
             NULL::text, NULL::text, 'session_lifecycle_commands', l.command_id::text,
             l.status::text || ':' || l.attempts::text,
             jsonb_build_object('command_type', l.command_type, 'source', l.source, 'attempts', l.attempts),
             NULL::text,
             jsonb_build_object('has_result', l.result IS NOT NULL, 'has_error', l.last_error IS NOT NULL),
             CASE WHEN l.result IS NULL AND l.last_error IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(COALESCE(l.result::text, l.last_error), 'UTF8'), 'sha256'), 'hex') END,
             NULL::integer, COALESCE(l.updated_at, l.created_at)
        FROM kortix.session_lifecycle_commands l WHERE l.account_id = ${accountId}::uuid
      UNION ALL
      SELECT p.account_id, ps.project_id, p.session_id, NULL::text, NULL::uuid, 'system',
             NULL::text, NULL::text, NULL::text, 0::integer, 'provider', NULL::text,
             CASE WHEN p.outcome = 'ok' THEN 'success' WHEN p.outcome = 'stopped' THEN 'denied' ELSE 'failure' END,
             'provider.' || p.kind, 'completed', 'provider_event', p.id::text, p.id::text,
             NULL::text, NULL::text, 'provider_events', p.id::text, p.outcome,
             jsonb_build_object('provider', p.provider, 'kind', p.kind, 'attempts', p.attempts),
             NULL::text,
             jsonb_build_object('marks', p.marks),
             CASE WHEN p.error IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(p.error, 'UTF8'), 'sha256'), 'hex') END,
             p.total_ms, p.created_at
        FROM kortix.provider_events p
        LEFT JOIN kortix.project_sessions ps ON ps.session_id = p.session_id
       WHERE p.account_id = ${accountId}::uuid
      UNION ALL
      SELECT u.account_id, u.project_id, u.session_id, NULL::text, u.actor_user_id,
             CASE WHEN u.session_id IS NULL THEN 'human' ELSE 'agent' END,
             NULL::text, NULL::text, NULL::text, 0::integer, 'llm_gateway', NULL::text,
             CASE WHEN u.upstream_status IS NULL OR u.upstream_status < 400 THEN 'success' ELSE 'failure' END,
             'llm.usage', 'completed', 'usage_event', u.event_id::text, u.event_id::text,
             NULL::text, NULL::text, 'usage_events', u.event_id::text,
             COALESCE(u.upstream_status::text, 'ok'),
             jsonb_build_object('provider', u.provider, 'model', u.model, 'route', u.route, 'streaming', u.streaming),
             NULL::text,
             jsonb_build_object('input_tokens', u.input_tokens, 'output_tokens', u.output_tokens,
               'cached_tokens', u.cached_tokens, 'cache_write_tokens', u.cache_write_tokens,
               'cost_usd', u.cost_usd), NULL::text, NULL::integer, u.created_at
        FROM kortix.usage_events u WHERE u.account_id = ${accountId}::uuid
      UNION ALL
      SELECT g.account_id, g.project_id, g.session_id, NULL::text, g.actor_user_id,
             CASE WHEN g.session_id IS NULL THEN 'human' ELSE 'agent' END,
             NULL::text, NULL::text, NULL::text, 0::integer, 'llm_gateway', NULL::text,
             CASE WHEN g.ok THEN 'success' ELSE 'failure' END, 'llm.request', 'completed',
             'gateway_request', g.log_id::text, g.log_id::text, NULL::text, g.request_id,
             'gateway_request_logs', g.log_id::text, g.status::text,
             jsonb_build_object('requested_model', g.requested_model, 'resolved_model', g.resolved_model,
               'provider', g.provider, 'streaming', g.streaming, 'attempts', g.attempts),
             NULL::text,
             jsonb_build_object('status', g.status, 'input_tokens', g.input_tokens,
               'output_tokens', g.output_tokens, 'final_cost', g.final_cost),
             CASE WHEN g.error_message IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(g.error_message, 'UTF8'), 'sha256'), 'hex') END,
             g.latency_ms, g.created_at
        FROM kortix.gateway_request_logs g WHERE g.account_id = ${accountId}::uuid
      UNION ALL
      SELECT t.account_id, t.project_id, t.session_id, NULL::text, t.actor_user_id,
             COALESCE(t.actor_type, CASE WHEN t.actor_user_id IS NULL THEN 'system' ELSE 'human' END),
             NULL::text, NULL::text, NULL::text, 0::integer, 'connector', NULL::text,
             CASE WHEN t.phase = 'started' THEN 'pending'
                  WHEN t.success THEN 'success' ELSE 'failure' END,
             'connector.computer.' || t.operation, t.phase, 'computer_tunnel', t.tunnel_id::text,
             t.log_id::text, NULL::text, NULL::text, 'tunnel_audit_logs', t.log_id::text,
             t.phase,
             jsonb_build_object(
               'method', t.request_summary ->> 'method',
               'has_path', t.request_summary ? 'path',
               'has_command', t.request_summary ? 'command',
               'has_cwd', t.request_summary ? 'cwd',
               'argument_count', COALESCE((t.request_summary ->> 'argumentCount')::integer, 0),
               'content_size', COALESCE((t.request_summary ->> 'contentSize')::integer, 0)
             ),
             NULL::text,
             jsonb_build_object('capability', t.capability, 'bytes_transferred', t.bytes_transferred),
             CASE WHEN t.error_message IS NULL THEN NULL
                  WHEN t.error_message ~ '^sha256:[0-9a-f]{64}$' THEN substring(t.error_message FROM 8)
                  ELSE encode(extensions.digest(convert_to(t.error_message, 'UTF8'), 'sha256'), 'hex') END,
             t.duration_ms,
             CASE WHEN t.phase = 'started' OR t.duration_ms IS NULL THEN t.created_at
                  ELSE t.created_at + (t.duration_ms * interval '1 millisecond') END
        FROM kortix.tunnel_audit_logs t WHERE t.account_id = ${accountId}::uuid
      UNION ALL
      SELECT pr.account_id, x.project_id, x.session_id, NULL::text, NULL::uuid, 'system',
             NULL::text, NULL::text, NULL::text, 0::integer, 'automation', NULL::text,
             CASE WHEN x.status IN ('completed','succeeded') THEN 'success'
                  WHEN x.status IN ('failed','dead_lettered') THEN 'failure' ELSE 'pending' END,
             'trigger.' || x.slug, x.status, 'trigger_execution', x.execution_id::text,
             x.execution_id::text, NULL::text, NULL::text, 'project_trigger_executions',
             x.execution_id::text, x.status || ':' || x.attempts::text,
             jsonb_build_object('slug', x.slug, 'scheduled_for', x.scheduled_for, 'attempts', x.attempts),
             NULL::text, NULL::jsonb,
             CASE WHEN x.last_error IS NULL THEN NULL ELSE
               encode(extensions.digest(convert_to(x.last_error, 'UTF8'), 'sha256'), 'hex') END,
             NULL::integer, COALESCE(x.updated_at, x.created_at)
        FROM kortix.project_trigger_executions x
        JOIN kortix.projects pr ON pr.project_id = x.project_id
       WHERE pr.account_id = ${accountId}::uuid
    ), missing AS (
      SELECT c.*
        FROM candidates c
        LEFT JOIN kortix.audit_events a
          ON a.source_ledger = c.source_ledger
         AND a.source_record_id = c.source_record_id
         AND a.phase = c.phase
         AND a.source_revision IS NOT DISTINCT FROM c.source_revision
       WHERE a.event_id IS NULL
       ORDER BY c.occurred_at, c.source_ledger, c.source_record_id
       LIMIT ${limit + 1}
    ), page AS (
      SELECT * FROM missing
       ORDER BY occurred_at, source_ledger, source_record_id
       LIMIT ${limit}
    ), inserted AS (
    INSERT INTO kortix.audit_events(
      account_id, project_id, session_id, opencode_session_id, actor_user_id, actor_type,
      agent_name, initiator_actor_type, initiator_actor_id, delegation_depth,
      authoritative_source, client_reported_source, outcome, action, phase,
      resource_type, resource_id,
      execution_id, message_id, request_id, source_ledger, source_record_id,
      source_revision, input_summary, input_sha256, output_summary, output_sha256,
      duration_ms, occurred_at
    )
    SELECT account_id, project_id, session_id, opencode_session_id, actor_user_id, actor_type,
           agent_name, initiator_actor_type, initiator_actor_id, delegation_depth,
           authoritative_source, client_reported_source, outcome, action, phase,
           resource_type, resource_id,
           execution_id, message_id, request_id, source_ledger, source_record_id,
           source_revision, input_summary, input_sha256, output_summary, output_sha256,
           duration_ms, occurred_at
      FROM page
    ON CONFLICT DO NOTHING
    RETURNING source_ledger AS "sourceLedger"
    )
    SELECT "sourceLedger", false AS "marker", NULL::boolean AS "hasMore"
      FROM inserted
    UNION ALL
    SELECT NULL::text AS "sourceLedger", true AS "marker",
           ((SELECT count(*) FROM missing) > ${limit}) AS "hasMore"
  `);
  const resultRows = Array.from(
    rows as unknown as Array<{
      sourceLedger: string | null;
      marker: boolean;
      hasMore: boolean | null;
    }>,
  );
  const insertedRows = resultRows.filter(
    (row): row is typeof row & { sourceLedger: string } => !row.marker && row.sourceLedger !== null,
  );
  const hasMore = resultRows.find((row) => row.marker)?.hasMore;
  if (hasMore === null || hasMore === undefined) {
    throw new Error('audit reconciliation query did not return its completion marker');
  }
  const bySource: Record<string, number> = {};
  for (const row of insertedRows)
    bySource[row.sourceLedger] = (bySource[row.sourceLedger] ?? 0) + 1;
  return {
    inserted: insertedRows.length,
    complete: !hasMore,
    by_source: bySource,
  };
}
