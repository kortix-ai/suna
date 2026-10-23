import { projectSessionPublicShares, projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { publicShareTokenHash, type ResponseSnapshot } from '../../shared/session-public-shares';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { sessionHasPersonalConnectorBinding } from './session-connector-bindings';
import { sessionPersonOnlyPlaintextSecrets } from './secret-audience';

/**
 * The anonymous read of a response share: ONLY the snapshot fields. 404 for an
 * unknown token or a token of another resource type; 410 once revoked, or when
 * the session was deleted or the project archived.
 */
export async function readPublicResponse(token: string) {
  const [row] = await db
    .select({
      accountId: projectSessionPublicShares.accountId,
      projectId: projectSessionPublicShares.projectId,
      sessionId: projectSessionPublicShares.sessionId,
      liveSessionId: projectSessions.sessionId,
      resourceType: projectSessionPublicShares.resourceType,
      revokedAt: projectSessionPublicShares.revokedAt,
      expiresAt: projectSessionPublicShares.expiresAt,
      snapshot: projectSessionPublicShares.snapshot,
      snapshotAt: projectSessionPublicShares.snapshotAt,
      sessionMetadata: projectSessions.metadata,
      projectStatus: sql<string | null>`(SELECT p.status::text FROM kortix.projects p WHERE p.project_id = ${qualifiedColumn(projectSessionPublicShares.projectId)})`,
    })
    .from(projectSessionPublicShares)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, projectSessionPublicShares.sessionId))
    .where(eq(projectSessionPublicShares.tokenHash, publicShareTokenHash(token)))
    .limit(1);
  if (!row || row.resourceType !== 'response' || !row.snapshot || !row.snapshotAt) {
    return { ok: false as const, status: 404 as const, error: 'Share link not found' };
  }
  const gone =
    row.liveSessionId === null ||
    row.projectStatus === null ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) ||
    typeof (row.sessionMetadata as Record<string, unknown> | null)?.deletedAt === 'string' ||
    row.projectStatus === 'archived';
  if (gone) return { ok: false as const, status: 410 as const, error: 'Share link revoked' };
  const [personalConnection, personalSecrets] = await Promise.all([
    sessionHasPersonalConnectorBinding(row),
    sessionPersonOnlyPlaintextSecrets(row),
  ]);
  if (personalConnection || personalSecrets.length > 0) {
    return { ok: false as const, status: 410 as const, error: 'Share link revoked' };
  }
  const s = row.snapshot as unknown as ResponseSnapshot;
  return {
    ok: true as const,
    response: {
      title: s.title,
      prompt: s.prompt ?? null,
      markdown: s.markdown,
      agent_name: s.agent_name,
      model_id: s.model_id,
      responded_at: s.responded_at,
      shared_at: row.snapshotAt.toISOString(),
    },
  };
}
