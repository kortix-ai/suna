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
import { ProjectRow, isPlainObject, normalizeString, readBody, serializeSessionSandboxConfig } from '../lib/serializers';
import { buildSessionSandboxEnvVars, sandboxCallbackUnreachableReason } from '../lib/sessions';
import { ensureOpencodeSessionPin } from '../opencode-mapping';

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
    // Title mirror is MONOTONIC: a row that's in the snapshot but still has a
    // null title (OpenCode hasn't auto-titled it yet) must NOT erase a name we
    // already wrote. `?? current` keeps the existing name until a real title
    // arrives — fixes "title generated then vanishes on a later list snapshot".
    const desired = (rootEntry ? rootEntry.title : current) ?? current;
    const scopedSessions = Array.from(desiredByOcId.values())
      .filter((entry) => (rootByOcId.get(entry.id) ?? entry.id) === rootId)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const currentSessions = JSON.stringify(row.metadata?.opencode_sessions ?? []);
    const nextSessions = JSON.stringify(scopedSessions);
    if (desired === current && currentSessions === nextSessions) continue;
    const nextMetadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (desired) nextMetadata.name = desired;
    // no `else delete` — never wipe an existing name because a snapshot lacked a title.
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

// ── Unified session-open orchestration ──────────────────────────────────────

export type SessionStartStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

export interface SessionStartResult {
  /** Coarse lifecycle stage the client renders + polls on. */
  stage: SessionStartStage;
  /** Whether polling /start again can make progress (false = terminal). */
  retriable: boolean;
  /** Serialized session_sandboxes row (same shape as GET /sandbox), or null. */
  sandbox: Record<string, unknown> | null;
  /** Canonical OpenCode root pin (resolved client-side once the box is ready). */
  opencode_session_id: string | null;
  reason?: string;
}

function serializeSandboxRow(row: typeof sessionSandboxes.$inferSelect): Record<string, unknown> {
  return {
    sandbox_id: row.sandboxId,
    session_id: row.sessionId,
    project_id: row.projectId,
    account_id: row.accountId,
    provider: row.provider,
    external_id: row.externalId,
    base_url: row.baseUrl,
    status: row.status,
    config: serializeSessionSandboxConfig(row.config),
    metadata: row.metadata ?? {},
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * THE authoritative session-open path — the single call the dashboard uses to
 * bring a session's runtime up. Idempotent: provisions a missing sandbox,
 * resumes a hibernated/idle one, and resolves the canonical OpenCode pin once the
 * box is reachable. Returns ONE readiness payload the client polls until `ready`.
 * Collapses the old GET /sandbox + POST /wake + POST /ensure-opencode dance into
 * one orchestration so the client makes a single call instead of three racing ones.
 */
export async function openSession(args: {
  loaded: { row: { accountId: string; repoUrl: string; defaultBranch: string; manifestPath: string; metadata?: unknown }; userId: string };
  visible: { row: { status: string; sandboxProvider: string; baseRef: string | null; agentName: string | null; opencodeSessionId: string | null; accountId: string } };
  projectId: string;
  sessionId: string;
}): Promise<SessionStartResult> {
  const { loaded, visible, projectId, sessionId } = args;
  const accountId = visible.row.accountId;

  let [row] = await db
    .select()
    .from(sessionSandboxes)
    .where(and(
      eq(sessionSandboxes.sessionId, sessionId),
      eq(sessionSandboxes.projectId, projectId),
      eq(sessionSandboxes.accountId, accountId),
    ))
    .limit(1);

  // Resume a hibernated box in place (keeps its disk/workspace).
  if (row && row.status === 'stopped' && row.externalId
      && (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) {
    await resumeStoppedSandbox({
      sandboxId: row.sandboxId, sessionId: row.sessionId, accountId: row.accountId,
      provider: row.provider, externalId: row.externalId,
    });
    const [resumed] = await db.select().from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, row.sandboxId)).limit(1);
    if (resumed) row = resumed;
  }

  // No usable box → provision on open (or report a terminal state).
  const usable = row && (row.status === 'provisioning' || row.status === 'active');
  if (!usable) {
    if (['failed', 'stopped', 'completed'].includes(visible.row.status)) {
      return { stage: visible.row.status === 'failed' ? 'failed' : 'stopped', retriable: false, sandbox: null, opencode_session_id: null };
    }
    if (visible.row.status !== 'provisioning') {
      if (row) await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, sessionId)).catch(() => {});
      await kickProvisionOnOpen(loaded, visible.row, projectId, sessionId);
    }
    return { stage: 'provisioning', retriable: true, sandbox: null, opencode_session_id: null };
  }

  // Still provisioning, or active but external_id not yet written.
  if (row.status === 'provisioning' || !row.externalId) {
    return { stage: 'provisioning', retriable: true, sandbox: serializeSandboxRow(row), opencode_session_id: null };
  }

  // Active + external_id. The provider may have idle-auto-stopped the box while
  // the row still reads 'active' (the row lies until the next health probe), so
  // confirm with a lightweight provider status check and wake it in place if
  // needed. We deliberately do NOT do the heavy daemon round-trip (OpenCode pin
  // resolve) here — that would block this endpoint for ~8s on a still-booting box
  // and it's polled every second. OpenCode readiness is the client health poll's
  // job; the canonical-pin hook resolves the root once the box reports healthy.
  const provider = getProvider(row.provider as SandboxProviderName);
  let providerStatus: string;
  try {
    providerStatus = await provider.getStatus(row.externalId);
  } catch {
    providerStatus = 'unknown';
  }

  if (providerStatus !== 'running') {
    // Idle auto-stop: kick the start in the background; the client keeps polling.
    void provider.start(row.externalId).catch((err) =>
      console.warn(`[start] failed to wake sandbox ${row.externalId} (session ${sessionId}):`, err),
    );
    return { stage: 'starting', retriable: true, sandbox: serializeSandboxRow(row), opencode_session_id: null };
  }

  // Box is provider-running. Resolve OpenCode readiness + the canonical pin
  // server-side — safe now that the box is confirmed up, so the daemon answers
  // FAST (a 503 'not_ready' while OpenCode is still booting, not an 8s timeout
  // against a dead box). This keeps ALL the lifecycle logic server-side: the
  // client just polls until stage='ready' and gets the pin handed to it.
  const ensured = await ensureOpencodeSessionPin({
    projectId, sessionId, accountId,
    externalId: row.externalId, userId: loaded.userId,
    currentPin: visible.row.opencodeSessionId ?? null,
  });
  const booting = ensured.reason === 'not_ready' || ensured.reason === 'unreachable';
  return {
    stage: booting ? 'starting' : 'ready',
    retriable: booting,
    sandbox: serializeSandboxRow(row),
    opencode_session_id: ensured.pin,
    reason: ensured.reason,
  };
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
