import { describe, expect, test } from 'bun:test';
import { planLocalAuditV2LedgerRepair } from './local-audit-v2-ledger-repair';

const complete = {
  tables: ['audit_session_sequences', 'audit_webhook_deliveries'],
  auditColumns: [
    'agent_id', 'agent_name', 'authoritative_source', 'causation_id', 'client_reported_source',
    'delegation_depth', 'error_code', 'error_message', 'execution_id', 'initiator_actor_id',
    'initiator_actor_type', 'input_sha256', 'input_summary', 'integrity_hash',
    'integrity_previous_hash', 'message_id', 'opencode_session_id', 'output_sha256',
    'output_summary', 'parent_event_id', 'phase', 'session_sequence', 'source_ledger',
    'source_record_id', 'source_revision', 'tool_call_id', 'turn_id',
  ],
  tunnelColumns: ['actor_type', 'actor_user_id', 'phase', 'project_id', 'session_id'],
  functions: [
    'audit_connector_call', 'audit_enqueue_webhooks', 'audit_gateway_request',
    'audit_prepare_event', 'audit_project_session', 'audit_provider_event',
    'audit_reject_mutation', 'audit_session_lifecycle_command', 'audit_trigger_execution',
    'audit_tunnel_operation', 'audit_usage_event', 'audit_voice_turn',
  ],
  triggers: [
    'audit_events_append_only', 'audit_events_enqueue_webhooks', 'audit_events_prepare',
    'connector_calls_project_audit', 'gateway_request_logs_project_audit',
    'project_sessions_project_audit', 'project_trigger_executions_project_audit',
    'provider_events_project_audit', 'session_lifecycle_commands_project_audit',
    'tunnel_audit_logs_project_audit', 'usage_events_project_audit',
    'voice_call_turns_project_audit',
  ],
  indexes: ['idx_audit_webhook_delivery_due', 'idx_audit_webhook_delivery_event'],
};

describe('local audit-v2 ledger repair plan', () => {
  test('records a complete untracked schema once', () => {
    expect(planLocalAuditV2LedgerRepair(false, complete)).toBe(true);
    expect(planLocalAuditV2LedgerRepair(true, complete)).toBe(false);
  });

  test('leaves an untouched pre-v2 schema pending', () => {
    expect(
      planLocalAuditV2LedgerRepair(false, {
        tables: [], auditColumns: [], tunnelColumns: [], functions: [], triggers: [], indexes: [],
      }),
    ).toBe(false);
  });

  test('fails closed for a partial untracked schema', () => {
    expect(() =>
      planLocalAuditV2LedgerRepair(false, { ...complete, triggers: complete.triggers.slice(1) }),
    ).toThrow('partial local schema');
  });
});
