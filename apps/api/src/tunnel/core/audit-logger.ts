import { createHash } from 'node:crypto';
import { tunnelAuditLogs } from '@kortix/db';
import type { TunnelCapability } from 'agent-tunnel';
import { eq } from 'drizzle-orm';
import { getRequestContext } from '../../lib/request-context';
import type { AuditActorType } from '../../shared/audit';
import { db } from '../../shared/db';

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

export type AuditLogStart = Omit<
  AuditLogEntry,
  'success' | 'durationMs' | 'bytesTransferred' | 'errorMessage'
>;

export interface AuditLogCompletion {
  success: boolean;
  durationMs?: number;
  bytesTransferred?: number;
  errorMessage?: string;
}

export async function startAuditLog(entry: AuditLogStart): Promise<string> {
  const request = getRequestContext();
  const projectId = entry.projectId ?? request?.projectId ?? null;
  const sessionId = entry.sessionId ?? request?.sessionId ?? null;
  const actorUserId = entry.actorUserId ?? request?.userId ?? null;
  const [row] = await db
    .insert(tunnelAuditLogs)
    .values({
      tunnelId: entry.tunnelId,
      accountId: entry.accountId,
      projectId,
      sessionId,
      actorUserId,
      actorType: entry.actorType ?? (sessionId ? 'agent' : actorUserId ? 'human' : 'system'),
      capability: entry.capability,
      operation: entry.operation,
      requestSummary: entry.requestSummary,
      phase: 'started',
      success: false,
    })
    .returning({ logId: tunnelAuditLogs.logId });
  if (!row) throw new Error('tunnel audit start did not return a durable row');
  return row.logId;
}

export async function finishAuditLog(logId: string, completion: AuditLogCompletion): Promise<void> {
  const phase = completion.success ? 'completed' : 'failed';
  const errorMessage = completion.errorMessage
    ? `sha256:${createHash('sha256').update(completion.errorMessage).digest('hex')}`
    : null;
  const [row] = await db
    .update(tunnelAuditLogs)
    .set({
      phase,
      success: completion.success,
      durationMs: completion.durationMs,
      bytesTransferred: completion.bytesTransferred,
      errorMessage,
    })
    .where(eq(tunnelAuditLogs.logId, logId))
    .returning({ logId: tunnelAuditLogs.logId });
  if (!row) throw new Error(`tunnel audit row not found: ${logId}`);
}

export function buildRequestSummary(
  method: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { method };

  if (args.path) summary.path = true;
  if (args.command) summary.command = true;
  if (args.cwd) summary.cwd = true;
  if (Array.isArray(args.args)) summary.argumentCount = args.args.length;
  if (args.recursive !== undefined) summary.recursive = args.recursive;
  if (args.encoding) summary.encoding = args.encoding;

  if (args.content && typeof args.content === 'string') {
    summary.contentSize = args.content.length;
  }

  return summary;
}
