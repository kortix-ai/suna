import { gatewayRequestLogs } from '@kortix/db';
import { db } from './db';
import * as sharedDb from './db';
import { buildGatewayTraceRow, type GatewayTraceInput } from './gateway-trace-row';

// Namespace import + fallback: `auditDb` is optional on the module surface so the
// ~120 tests that mock '../shared/db' (with only `db`) keep working — see
// shared/audit.ts for the full rationale.
const auditDb = sharedDb.auditDb ?? db;

export type { GatewayTraceInput };

// Written on every LLM gateway request. An AFTER-INSERT trigger
// (`audit_gateway_request`) fans this out into `kortix.audit_events`, so this is
// the single highest-frequency source of the per-session audit lock convoy. Use
// the isolated audit pool so that convoy can never pin a main-pool connection
// the gateway's own auth query needs — the failure that surfaced as "Bad
// Gateway" (EOF) on the box. This is best-effort request logging; losing a row
// under extreme load is acceptable, starving auth is not.
export async function recordGatewayTrace(input: GatewayTraceInput): Promise<void> {
  await auditDb
    .insert(gatewayRequestLogs)
    .values(buildGatewayTraceRow(input))
    .onConflictDoNothing({ target: gatewayRequestLogs.requestId });
}
