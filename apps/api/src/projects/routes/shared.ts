import { reopenComputeForSandbox } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { PROJECT_ACTIONS, authorize } from '../../iam';
import { deriveRequestContext } from '../../iam/cache';
import { auth, json } from '../../openapi';
import { getProvider } from '../../platform/providers';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { db } from '../../shared/db';
import { resolveBranchTip } from '../git';
import { rehydrateSessionChat } from '../legacy-migration-rehydrate';
import { changeRequests, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveProjectGitAuth } from '../lib/git';
import { ProjectRow, isPlainObject, normalizeString, readBody } from '../lib/serializers';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';

export const syncOpencodeSessionsHandler = async (c: any) => {
  const userId = c.get('userId') as string;
  const body = await readBody(c);
  const rawEntries = body.entries;
  if (!Array.isArray(rawEntries)) {
    return c.json({ error: 'entries must be an array' }, 400);
  }

  type OpenCodeSessionSnapshot = {
    id: string;
    title: string | null;
    parent_id: string | null;
    project_id: string | null;
    created_at: number | null;
    updated_at: number | null;
    archived_at: number | null;
  };

  const desiredByOcId = new Map<string, OpenCodeSessionSnapshot>();
  for (const raw of rawEntries) {
    if (!isPlainObject(raw)) continue;
    const opencodeSessionId = normalizeString(
      raw.opencode_session_id ?? raw.opencodeSessionId,
    );
    if (!opencodeSessionId) continue;
    const title = normalizeString(raw.title);
    const parentId = normalizeString(raw.parent_id ?? raw.parentID ?? raw.parentId);
    const projectId = normalizeString(raw.project_id ?? raw.projectID ?? raw.projectId);
    const createdAt = typeof raw.created_at === 'number'
      ? raw.created_at
      : typeof raw.createdAt === 'number'
        ? raw.createdAt
        : null;
    const updatedAt = typeof raw.updated_at === 'number'
      ? raw.updated_at
      : typeof raw.updatedAt === 'number'
        ? raw.updatedAt
        : null;
    const archivedAt = typeof raw.archived_at === 'number'
      ? raw.archived_at
      : typeof raw.archivedAt === 'number'
        ? raw.archivedAt
        : null;
    desiredByOcId.set(opencodeSessionId, {
      id: opencodeSessionId,
      title,
      parent_id: parentId,
      project_id: projectId,
      created_at: createdAt,
      updated_at: updatedAt,
      archived_at: archivedAt,
    });
  }
  if (desiredByOcId.size === 0) return c.json({ updated: 0 });

  const ids = Array.from(desiredByOcId.keys());
  const rootByOcId = new Map<string, string>();
  const resolveRoot = (id: string): string => {
    const cached = rootByOcId.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) break;
      seen.add(current);
      const parent = desiredByOcId.get(current)?.parent_id;
      if (!parent) break;
      if (!desiredByOcId.has(parent)) {
        current = parent;
        break;
      }
      current = parent;
    }
    for (const seenId of seen) rootByOcId.set(seenId, current);
    return current;
  };
  for (const id of ids) resolveRoot(id);
  const rootIds = Array.from(new Set(Array.from(rootByOcId.values())));
  const rows = await db
    .select()
    .from(projectSessions)
    .where(inArray(projectSessions.opencodeSessionId, Array.from(new Set([...ids, ...rootIds]))));
  if (rows.length === 0) return c.json({ updated: 0 });

  // Per-row IAM authz. The engine answers from a per-request cache
  // (see iam/cache.ts) so duplicate (account, project) probes collapse
  // to a single SQL pass — N rows over K distinct projects = K
  // authorize() calls, not N.
  const requestCtx = deriveRequestContext(c);
  const actingTokenId =
    ((c as unknown as { get(k: string): unknown }).get('iamTokenId') as
      | string
      | undefined) ?? undefined;

  let updated = 0;
  for (const row of rows) {
    const verdict = await authorize(
      userId,
      row.accountId,
      PROJECT_ACTIONS.PROJECT_WRITE,
      { type: 'project', id: row.projectId },
      actingTokenId,
      requestCtx,
    );
    if (!verdict.allowed) continue;
    const ocId = row.opencodeSessionId;
    if (!ocId) continue;
    const rootId = rootByOcId.get(ocId) ?? ocId;
    const current = typeof row.metadata?.name === 'string' ? row.metadata.name : null;
    const rootEntry = desiredByOcId.get(ocId);
    const desired = rootEntry ? rootEntry.title : current;
    const scopedSessions = Array.from(desiredByOcId.values())
      .filter((entry) => (rootByOcId.get(entry.id) ?? entry.id) === rootId)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const currentSessions = JSON.stringify(row.metadata?.opencode_sessions ?? []);
    const nextSessions = JSON.stringify(scopedSessions);
    if (desired === current && currentSessions === nextSessions) continue;
    const nextMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (desired) nextMetadata.name = desired;
    else delete nextMetadata.name;
    nextMetadata.opencode_sessions = scopedSessions;
    await db
      .update(projectSessions)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(projectSessions.sessionId, row.sessionId));
    updated += 1;
  }
  return c.json({ updated });
};


/**
 * Resume a hibernated (status='stopped') session sandbox IN PLACE instead of
 * destroying it and cold-reprovisioning a fresh one. A stopped row whose
 * `externalId` is still set is a powered-down VM whose disk — the repo clone,
 * installed deps, opencode — is intact, so resuming it skips the dominant boot
 * costs (snapshot pull + clone + deps).
 *
 * Atomically wins the stopped→active transition (so concurrent opens don't
 * double-start the provider), flips the session back to `running`, reopens
 * compute metering, and kicks the provider start in the background. The
 * caller returns `active` immediately; the frontend's existing health poll
 * waits for the container to come back — identical to the idle-wake path.
 *
 * On a hard provider-start failure the row is reverted to `stopped` so the
 * next open simply retries the resume (transient blips self-heal).
 *
 * Returns true when THIS call won the transition (and kicked the start).
 */
export async function resumeStoppedSandbox(row: {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: string;
  externalId: string | null;
}): Promise<boolean> {
  if (!row.externalId) return false;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) return false;

  const now = new Date();
  // Conditional update = the lock: only the request that flips stopped→active
  // proceeds to start the VM. Concurrent polls see `active` and just return it.
  const [won] = await db
    .update(sessionSandboxes)
    .set({ status: 'active', updatedAt: now })
    .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), eq(sessionSandboxes.status, 'stopped')))
    .returning();
  if (!won) return false;

  await db
    .update(projectSessions)
    .set({ status: 'running', updatedAt: now })
    .where(eq(projectSessions.sessionId, row.sessionId))
    .catch((err) => console.warn(`[projects] failed to mark session running on resume for ${row.sessionId}:`, err));

  void reopenComputeForSandbox(row.sandboxId, row.accountId, row.sessionId).catch((err) =>
    console.warn(`[projects] compute reopen failed for ${row.sandboxId}:`, err),
  );

  const provider = getProvider(row.provider as SandboxProviderName);
  void provider.start(row.externalId).catch(async (err) => {
    console.warn(`[projects] failed to resume sandbox ${row.externalId} for session ${row.sessionId}:`, err);
    // Revert so a later open retries the resume instead of spinning the health
    // poll against a VM that never came up.
    await db
      .update(sessionSandboxes)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
      .catch(() => {});
  });
  return true;
}

export async function kickProvisionOnOpen(
  loaded: { row: { accountId: string; repoUrl: string; defaultBranch: string; manifestPath: string }; userId: string },
  session: { sandboxProvider: string; baseRef: string | null; agentName: string | null },
  projectId: string,
  sessionId: string,
): Promise<void> {
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(providerName)) return;
  if (sandboxCallbackUnreachableReason()) return;
  const gitAuth = await resolveProjectGitAuth(loaded.row as ProjectRow);
  await db.update(projectSessions)
    .set({ status: 'provisioning', error: null, updatedAt: new Date() })
    .where(eq(projectSessions.sessionId, sessionId));
  // Migrated session — restore its original chat as part of provisioning, before
  // the sandbox goes 'active' (so the frontend's ensure-opencode pin survives).
  const legacySandboxId = (loaded.row as { metadata?: { legacy_migration?: { source_sandbox_id?: unknown } } })
    .metadata?.legacy_migration?.source_sandbox_id;

  void (async () => {
    try {
      const extraEnvVars = await buildSessionSandboxEnvVars({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        userId: loaded.userId,
        repoUrl: loaded.row.repoUrl,
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        agentName: session.agentName ?? 'default',
      });
      await provisionSessionSandbox({
        sandboxId: sessionId,
        accountId: loaded.row.accountId,
        projectId,
        userId: loaded.userId,
        provider: providerName,
        metadata: { session_id: sessionId, project_id: projectId, opened_at: new Date().toISOString() },
        extraEnvVars,
        gitProject: {
          projectId,
          repoUrl: loaded.row.repoUrl,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          gitAuthToken: gitAuth.auth?.token ?? null,
        },
        baseRef: session.baseRef ?? loaded.row.defaultBranch,
        beforeActive: typeof legacySandboxId === 'string'
          ? (externalId) => rehydrateSessionChat({ sessionId, legacySandboxId, newExternalId: externalId })
          : undefined,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox provisioning failed';
      console.error(`[projects] provision-on-open failed for ${sessionId}:`, err);
      await db.update(projectSessions)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(projectSessions.sessionId, sessionId)).catch(() => {});
    }
  })();
}


export async function refreshCrTips(input: {
  cr: typeof changeRequests.$inferSelect;
  project: {
    projectId: string;
    repoUrl: string;
    defaultBranch: string;
    manifestPath: string;
    gitAuthToken?: string | null;
  };
}) {
  const { cr, project } = input;
  if (cr.status !== 'open') return;
  try {
    const [baseSha, headSha] = await Promise.all([
      resolveBranchTip(project, cr.baseRef),
      resolveBranchTip(project, cr.headRef),
    ]);
    if (cr.headCommitSha === headSha && cr.baseCommitSha === baseSha) return;
    await db
      .update(changeRequests)
      .set({ headCommitSha: headSha, baseCommitSha: baseSha, updatedAt: new Date() })
      .where(eq(changeRequests.crId, cr.crId));
  } catch (error) {
    // Repo unreachable or branch missing — leave the CR alone so the UI can
    // still render the metadata it has.
    console.warn('[change-requests] tip refresh failed', {
      crId: cr.crId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// GET /v1/projects/:projectId/change-requests?status=open|merged|closed|all
