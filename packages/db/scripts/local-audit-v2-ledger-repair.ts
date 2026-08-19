import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATION_NAME = '20260807221200000_centralized_audit_v2';
const MIGRATION_FILE = `${MIGRATION_NAME}.sql`;
const MIGRATION_SHA256 = '769b863ef0b62c4693e232cf102757ce3c3ee904f0f44c9aea450901a56e07f9';

const AUDIT_EVENT_COLUMNS = [
  'agent_id',
  'agent_name',
  'authoritative_source',
  'causation_id',
  'client_reported_source',
  'delegation_depth',
  'error_code',
  'error_message',
  'execution_id',
  'initiator_actor_id',
  'initiator_actor_type',
  'input_sha256',
  'input_summary',
  'integrity_hash',
  'integrity_previous_hash',
  'message_id',
  'opencode_session_id',
  'output_sha256',
  'output_summary',
  'parent_event_id',
  'phase',
  'session_sequence',
  'source_ledger',
  'source_record_id',
  'source_revision',
  'tool_call_id',
  'turn_id',
] as const;
const TUNNEL_COLUMNS = ['actor_type', 'actor_user_id', 'phase', 'project_id', 'session_id'] as const;
const FUNCTIONS = [
  'audit_connector_call',
  'audit_enqueue_webhooks',
  'audit_gateway_request',
  'audit_prepare_event',
  'audit_project_session',
  'audit_provider_event',
  'audit_reject_mutation',
  'audit_session_lifecycle_command',
  'audit_trigger_execution',
  'audit_tunnel_operation',
  'audit_usage_event',
  'audit_voice_turn',
] as const;
const TRIGGERS = [
  'audit_events_append_only',
  'audit_events_enqueue_webhooks',
  'audit_events_prepare',
  'connector_calls_project_audit',
  'gateway_request_logs_project_audit',
  'project_sessions_project_audit',
  'project_trigger_executions_project_audit',
  'provider_events_project_audit',
  'session_lifecycle_commands_project_audit',
  'tunnel_audit_logs_project_audit',
  'usage_events_project_audit',
  'voice_call_turns_project_audit',
] as const;
const INDEXES = ['idx_audit_webhook_delivery_due', 'idx_audit_webhook_delivery_event'] as const;

interface AuditV2Signature {
  tables: string[];
  auditColumns: string[];
  tunnelColumns: string[];
  functions: string[];
  triggers: string[];
  indexes: string[];
}

function exact(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function planLocalAuditV2LedgerRepair(
  ledgerApplied: boolean,
  signature: AuditV2Signature,
): boolean {
  if (ledgerApplied) return false;
  const sections: Array<[string[], readonly string[]]> = [
    [signature.tables, ['audit_session_sequences', 'audit_webhook_deliveries']],
    [signature.auditColumns, AUDIT_EVENT_COLUMNS],
    [signature.tunnelColumns, TUNNEL_COLUMNS],
    [signature.functions, FUNCTIONS],
    [signature.triggers, TRIGGERS],
    [signature.indexes, INDEXES],
  ];
  const present = sections.reduce((count, [actual]) => count + actual.length, 0);
  if (present === 0) return false;
  if (!sections.every(([actual, expected]) => exact(actual, expected))) {
    throw new Error(
      `${MIGRATION_NAME} has a partial local schema without a migration ledger row; refusing to mark it applied.`,
    );
  }
  return true;
}

async function readSignature(client: pg.Client): Promise<AuditV2Signature> {
  const tables = await client.query<{ name: string }>(`
      select relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kortix'
         and c.relkind = 'r'
         and relname = any($1::text[])
       order by relname
    `, [['audit_session_sequences', 'audit_webhook_deliveries']]);
  const auditColumns = await client.query<{ name: string }>(`
      select column_name as name
        from information_schema.columns
       where table_schema = 'kortix'
         and table_name = 'audit_events'
         and column_name = any($1::text[])
       order by column_name
    `, [AUDIT_EVENT_COLUMNS]);
  const tunnelColumns = await client.query<{ name: string }>(`
      select column_name as name
        from information_schema.columns
       where table_schema = 'kortix'
         and table_name = 'tunnel_audit_logs'
         and column_name = any($1::text[])
       order by column_name
    `, [TUNNEL_COLUMNS]);
  const functions = await client.query<{ name: string }>(`
      select proname as name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'kortix'
         and proname = any($1::text[])
       order by proname
    `, [FUNCTIONS]);
  const triggers = await client.query<{ name: string }>(`
      select tgname as name
        from pg_trigger
       where not tgisinternal
         and tgname = any($1::text[])
       order by tgname
    `, [TRIGGERS]);
  const indexes = await client.query<{ name: string }>(`
      select indexname as name
        from pg_indexes
       where schemaname = 'kortix'
         and indexname = any($1::text[])
       order by indexname
    `, [INDEXES]);
  const names = (result: pg.QueryResult<{ name: string }>) => result.rows.map((row) => row.name);
  return {
    tables: names(tables),
    auditColumns: names(auditColumns),
    tunnelColumns: names(tunnelColumns),
    functions: names(functions),
    triggers: names(triggers),
    indexes: names(indexes),
  };
}

export async function repairLocalAuditV2Ledger(
  databaseUrl: string,
  migrationsDir: string,
): Promise<boolean> {
  const migration = readFileSync(join(migrationsDir, MIGRATION_FILE));
  const actualSha256 = createHash('sha256').update(migration).digest('hex');
  if (actualSha256 !== MIGRATION_SHA256) {
    throw new Error(
      `${MIGRATION_FILE} checksum mismatch: expected ${MIGRATION_SHA256}, received ${actualSha256}`,
    );
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const ledgerExists = await client.query<{ exists: boolean }>(
      "select to_regclass('kortix_migrations.pgmigrations') is not null as exists",
    );
    if (!ledgerExists.rows[0]?.exists) return false;

    await client.query('begin');
    try {
      await client.query('lock table kortix_migrations.pgmigrations in exclusive mode');
      const applied = await client.query(
        'select 1 from kortix_migrations.pgmigrations where name = $1 limit 1',
        [MIGRATION_NAME],
      );
      const repair = planLocalAuditV2LedgerRepair(applied.rowCount === 1, await readSignature(client));
      if (!repair) {
        await client.query('commit');
        return false;
      }
      const inserted = await client.query(
        `insert into kortix_migrations.pgmigrations (name, run_on)
         select $1::varchar, clock_timestamp()
          where not exists (
            select 1 from kortix_migrations.pgmigrations where name = $1::varchar
          )`,
        [MIGRATION_NAME],
      );
      if (inserted.rowCount !== 1) {
        throw new Error(`Could not record ${MIGRATION_NAME} in the local migration ledger.`);
      }
      await client.query('commit');
      return true;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    await client.end();
  }
}
