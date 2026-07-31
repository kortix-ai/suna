import { tunnelAuditLogs } from '@kortix/db';
import { db } from '../../shared/db';
import { getRequestContext } from '../../lib/request-context';
import { recordAuditEvent, type AuditActorType } from '../../shared/audit';
import type { TunnelCapability } from 'agent-tunnel';
import { tunnelCentralAuditEvent } from './tunnel-audit-event';

export interface AuditLogEntry {
  tunnelId: string;
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorType?: AuditActorType | null;
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
    const request = getRequestContext();
    await Promise.all([
      db.insert(tunnelAuditLogs).values({
        tunnelId: entry.tunnelId,
        accountId: entry.accountId,
        capability: entry.capability,
        operation: entry.operation,
        requestSummary: entry.requestSummary,
        success: entry.success,
        durationMs: entry.durationMs,
        bytesTransferred: entry.bytesTransferred,
        errorMessage: entry.errorMessage,
      }),
      recordAuditEvent(
        tunnelCentralAuditEvent({
          ...entry,
          projectId: entry.projectId ?? request?.projectId ?? null,
          sessionId: entry.sessionId ?? request?.sessionId ?? null,
          actorUserId: entry.actorUserId ?? request?.userId ?? null,
        }),
      ),
    ]);
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
