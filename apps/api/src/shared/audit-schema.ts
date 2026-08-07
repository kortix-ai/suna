import { z } from '@hono/zod-openapi';

/** Public canonical audit contract shared by account, project, and session routes. */
export const AuditEventSchema = z
  .object({
    event_id: z.string().uuid(),
    occurred_at: z.string(),
    account_id: z.string().uuid().nullable(),
    project_id: z.string().uuid().nullable(),
    session_id: z.string().nullable(),
    opencode_session_id: z.string().nullable(),
    turn_id: z.string().nullable(),
    message_id: z.string().nullable(),
    tool_call_id: z.string().nullable(),
    execution_id: z.string().nullable(),
    session_sequence: z.number().int().nullable(),
    actor_user_id: z.string().uuid().nullable(),
    actor_type: z.enum(['human', 'agent', 'service_account', 'system']).nullable(),
    agent_id: z.string().nullable(),
    agent_name: z.string().nullable(),
    initiator_actor_type: z.string().nullable(),
    initiator_actor_id: z.string().nullable(),
    parent_event_id: z.string().uuid().nullable(),
    delegation_depth: z.number().int(),
    source: z.string().nullable(),
    authoritative_source: z.string().nullable(),
    client_reported_source: z.string().nullable(),
    outcome: z.enum(['success', 'failure', 'denied', 'pending']).nullable(),
    action: z.string(),
    phase: z.string(),
    resource_type: z.string(),
    resource_id: z.string().nullable(),
    http_status: z.number().int().nullable(),
    duration_ms: z.number().int().nullable(),
    request_id: z.string().nullable(),
    trace_id: z.string().nullable(),
    correlation_id: z.string().nullable(),
    causation_id: z.string().nullable(),
    source_ledger: z.string().nullable(),
    source_record_id: z.string().nullable(),
    source_revision: z.string().nullable(),
    input_summary: z.record(z.unknown()).nullable(),
    output_summary: z.record(z.unknown()).nullable(),
    input_sha256: z.string().nullable(),
    output_sha256: z.string().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    integrity_previous_hash: z.string().nullable(),
    integrity_hash: z.string().nullable(),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()).nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    metadata: z.record(z.unknown()),
  })
  .openapi('AuditEvent');

export const AuditListSchema = z
  .object({
    events: z.array(AuditEventSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('AuditEventList');
