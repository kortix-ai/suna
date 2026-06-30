import { gatewayRequestLogs } from '@kortix/db';
import { db } from './db';
import { buildGatewayTraceRow, type GatewayTraceInput } from './gateway-trace-row';

export type { GatewayTraceInput };

export async function recordGatewayTrace(input: GatewayTraceInput): Promise<void> {
  await db
    .insert(gatewayRequestLogs)
    .values(buildGatewayTraceRow(input))
    .onConflictDoNothing({ target: gatewayRequestLogs.requestId });
}
