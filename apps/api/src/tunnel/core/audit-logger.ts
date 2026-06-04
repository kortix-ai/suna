import { tunnelAuditLogs } from '@kortix/db';
import { db } from '../../shared/db';
import type { TunnelCapability } from 'agent-tunnel';

export interface AuditLogEntry {
  tunnelId: string;
  accountId: string;
  capability: TunnelCapability;
  operation: string;
  requestSummary: Record<string, unknown>;
  success: boolean;
  durationMs?: number;
  bytesTransferred?: number;
  errorMessage?: string;
}


export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await db.insert(tunnelAuditLogs).values({
      tunnelId: entry.tunnelId,
      accountId: entry.accountId,
      capability: entry.capability,
      operation: entry.operation,
      requestSummary: entry.requestSummary,
      success: entry.success,
      durationMs: entry.durationMs,
      bytesTransferred: entry.bytesTransferred,
      errorMessage: entry.errorMessage,
    });
  } catch (err) {
    console.error('[tunnel-audit] Failed to write audit log:', err);
  }
}


export function buildRequestSummary(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { method };

  if (args.path) summary.path = args.path;
  if (args.command) summary.command = args.command;
  if (args.args) summary.args = args.args;
  if (args.cwd) summary.cwd = args.cwd;
  if (args.recursive !== undefined) summary.recursive = args.recursive;
  if (args.encoding) summary.encoding = args.encoding;

  if (args.content && typeof args.content === 'string') {
    summary.contentSize = (args.content as string).length;
  }

  return summary;
}
