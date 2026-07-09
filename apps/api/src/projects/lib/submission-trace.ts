/**
 * Work-submission trace — the platform-stapled, tamper-proof half of a
 * submission's detail. The agent authors title/summary/claims; the server
 * attaches what the session actually DID: the governed-action audit slice,
 * a cost snapshot, and a pointer to the transcript digest. Best-effort by
 * design: a trace failure must never block the submission itself.
 */

import { executorExecutions, gatewayRequestLogs, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

const AUDIT_SLICE_LIMIT = 50;

export interface SubmissionTraceAction {
  action: string;
  connector: string | null;
  risk: string;
  status: string;
  at: string;
}

export interface SubmissionTrace {
  transcript_ref: string;
  audit: SubmissionTraceAction[];
  audit_truncated: boolean;
  cost: { tokens: number; llm_cost: number; compute_cost: number } | null;
}

export async function buildSubmissionTrace(
  projectId: string,
  sessionId: string,
): Promise<SubmissionTrace | null> {
  try {
    const [auditRows, llmRows, computeRows] = await Promise.all([
      db
        .select({
          actionPath: executorExecutions.actionPath,
          connectorId: executorExecutions.connectorId,
          risk: executorExecutions.risk,
          status: executorExecutions.status,
          createdAt: executorExecutions.createdAt,
        })
        .from(executorExecutions)
        .where(and(eq(executorExecutions.projectId, projectId), eq(executorExecutions.sessionId, sessionId)))
        .orderBy(desc(executorExecutions.createdAt))
        .limit(AUDIT_SLICE_LIMIT + 1),
      db
        .select({
          cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8`,
          tokens: sql<string>`coalesce(sum(${gatewayRequestLogs.inputTokens} + ${gatewayRequestLogs.outputTokens}), 0)::bigint`,
        })
        .from(gatewayRequestLogs)
        .where(and(eq(gatewayRequestLogs.projectId, projectId), eq(gatewayRequestLogs.sessionId, sessionId))),
      db
        .select({
          cost: sql<number>`coalesce(sum(${sandboxComputeSessions.costUsd}), 0)::float8`,
        })
        .from(sandboxComputeSessions)
        .innerJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, sandboxComputeSessions.sessionId))
        .where(and(eq(sessionSandboxes.projectId, projectId), eq(sandboxComputeSessions.sessionId, sessionId))),
    ]);

    const truncated = auditRows.length > AUDIT_SLICE_LIMIT;
    const audit = auditRows.slice(0, AUDIT_SLICE_LIMIT).map((r) => ({
      action: r.actionPath ?? '',
      connector: r.connectorId ?? null,
      risk: r.risk ?? 'none',
      status: r.status ?? '',
      at: r.createdAt?.toISOString() ?? '',
    }));

    const llm = llmRows[0];
    const compute = computeRows[0];
    const cost =
      llm || compute
        ? {
            tokens: Number(llm?.tokens ?? 0),
            llm_cost: Number(llm?.cost ?? 0),
            compute_cost: Number(compute?.cost ?? 0),
          }
        : null;

    return {
      transcript_ref: `/v1/projects/${projectId}/sessions/${sessionId}/transcript`,
      audit,
      audit_truncated: truncated,
      cost,
    };
  } catch (error) {
    console.warn('[review] submission trace unavailable', {
      projectId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
