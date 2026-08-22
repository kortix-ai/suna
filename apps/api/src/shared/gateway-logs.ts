import { gatewayRequestLogs } from '@kortix/db';
// The gateway_request_logs write's AFTER-INSERT trigger fans out an audit row,
// so route it through the isolated audit pool — its convoy must never starve the
// gateway's own auth query (the "Bad Gateway"/EOF root cause). See audit-db.ts.
import { auditDb } from './audit-db';
import { buildGatewayTraceRow, type GatewayTraceInput } from './gateway-trace-row';

export type { GatewayTraceInput };

export async function recordGatewayTrace(input: GatewayTraceInput): Promise<void> {
  await auditDb()
    .insert(gatewayRequestLogs)
    .values(buildGatewayTraceRow(input))
    .onConflictDoNothing({ target: gatewayRequestLogs.requestId });
}
