/**
 * Session environments (harness/worker split P1.7 — lazy compute).
 *
 * A pi worker session boots with NO environment: the worker box thinks, and
 * only a compute tool call (bash/read/write/glob/grep) needs somewhere to act.
 * That somewhere is this: the full daemon box — repo checkout on the session
 * branch, the session agent's granted secrets, `/file` + `/find` + `/pty` —
 * provisioned on the FIRST ensure call and resumed thereafter.
 *
 * Deliberate shape:
 * - **One environment per session**, enforced by `session_environments`'
 *   primary key. The claim is an INSERT … ON CONFLICT DO NOTHING; the loser
 *   polls the winner's row. No advisory locks.
 * - **The environment IS the session, credential-wise.** Its KORTIX_TOKEN is
 *   the session's own service key (read from `session_sandboxes.config`), so
 *   its git access, secret handles and callback rights are exactly the
 *   session's — no new credential surface, no separate revocation story.
 * - **The worker reaches it over the provider edge, not the session proxy.**
 *   The ensure response carries a preview URL + token; worker↔environment
 *   traffic never transits the control plane (gate G0: per-call proxied HTTP
 *   is the tax the split exists to avoid).
 * - **OpenCode is not required.** The box boots with
 *   KORTIX_BOOTSTRAP_OPENCODE_SESSION=0 — the daemon serves files/find/pty
 *   without an OpenCode session.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { getDaytona } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
import { ensureSandboxImage } from '../../snapshots/builder';
import type { GitBackedProject } from '../../projects/git';
import { buildSessionSandboxEnvVars } from '../../projects/lib/sessions';
import type { WorkspaceModeV2 } from '@kortix/manifest-schema';
import { getProvider } from '../providers';

const PROVIDER_CALL_TIMEOUT_MS = 30_000;
/** How long a losing claimant waits for the winner's provision. */
const CLAIM_WAIT_MS = 120_000;

export interface SessionEnvironmentInfo {
  sessionId: string;
  status: string;
  externalId: string | null;
  /** Direct provider-edge origin of the daemon (port 8000), null until active. */
  previewUrl: string | null;
  /** Edge auth token for previewUrl, null until active. */
  previewToken: string | null;
}

export class SessionEnvironmentError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = 'SessionEnvironmentError';
  }
}

async function readRow(sessionId: string) {
  const [row] = await db
    .select()
    .from(sessionEnvironments)
    .where(eq(sessionEnvironments.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

async function withPreview(row: {
  sessionId: string;
  status: string;
  externalId: string | null;
}): Promise<SessionEnvironmentInfo> {
  let previewUrl: string | null = null;
  let previewToken: string | null = null;
  if (row.status === 'active' && row.externalId) {
    try {
      const sandbox = await withTimeout(
        getDaytona().get(row.externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${row.externalId})`,
      );
      const preview = await withTimeout(
        (sandbox as unknown as {
          getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
        }).getPreviewLink(8000),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona getPreviewLink(${row.externalId}:8000)`,
      );
      previewUrl = preview.url.replace(/\/+$/, '');
      previewToken = preview.token ?? null;
    } catch (err) {
      console.warn(`[session-env] preview link for ${row.externalId} failed:`, err);
    }
  }
  return {
    sessionId: row.sessionId,
    status: row.status,
    externalId: row.externalId,
    previewUrl,
    previewToken,
  };
}

/** The session's own sandbox credential — the environment acts AS the session. */
async function sessionServiceKey(sessionId: string): Promise<string> {
  const [row] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const key = (row?.config as { serviceKey?: string } | null)?.serviceKey;
  if (!key) {
    throw new SessionEnvironmentError(
      'Session has no runtime credential yet — start the session before its environment.',
      409,
    );
  }
  return key;
}

async function resumeEnvironment(externalId: string): Promise<void> {
  const daytona = getDaytona();
  const sandbox = await withTimeout(
    daytona.get(externalId),
    PROVIDER_CALL_TIMEOUT_MS,
    `Daytona get(${externalId})`,
  );
  await withTimeout(
    (daytona as unknown as { start(sandbox: unknown, opts?: unknown): Promise<unknown> }).start(
      sandbox,
      { timeout: 60 },
    ),
    90_000,
    `Daytona start(${externalId})`,
  );
}

export interface EnsureSessionEnvironmentInput {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
  agentName: string;
  baseRef: string;
  gitProject: GitBackedProject;
  workspaceMode?: WorkspaceModeV2 | null;
}

/**
 * Idempotent: returns the session's environment, provisioning or resuming it
 * if needed. Every terminal failure marks the row 'error'; a later ensure
 * retries from there.
 */
export async function ensureSessionEnvironment(
  input: EnsureSessionEnvironmentInput,
): Promise<SessionEnvironmentInfo> {
  const existing = await readRow(input.sessionId);
  if (existing?.status === 'active' && existing.externalId) return withPreview(existing);
  if (existing?.status === 'stopped' && existing.externalId) {
    await resumeEnvironment(existing.externalId);
    const [resumed] = await db
      .update(sessionEnvironments)
      .set({ status: 'active', lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(sessionEnvironments.sessionId, input.sessionId))
      .returning();
    return withPreview(resumed);
  }

  // Claim. A brand-new session inserts; an errored one re-claims by flipping
  // 'error' → 'provisioning'. Whoever ends up NOT owning the claim polls.
  let owns = false;
  if (!existing) {
    const inserted = await db
      .insert(sessionEnvironments)
      .values({
        sessionId: input.sessionId,
        accountId: input.accountId,
        projectId: input.projectId,
        provider: 'daytona',
        status: 'provisioning',
      })
      .onConflictDoNothing()
      .returning();
    owns = inserted.length > 0;
  } else if (existing.status === 'error') {
    const reclaimed = await db
      .update(sessionEnvironments)
      .set({ status: 'provisioning', updatedAt: new Date() })
      .where(
        and(
          eq(sessionEnvironments.sessionId, input.sessionId),
          eq(sessionEnvironments.status, 'error'),
        ),
      )
      .returning();
    owns = reclaimed.length > 0;
  }

  if (!owns) {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await readRow(input.sessionId);
      if (row?.status === 'active' && row.externalId) return withPreview(row);
      if (row?.status === 'error') {
        throw new SessionEnvironmentError('Environment provisioning failed; retry.', 502);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new SessionEnvironmentError('Timed out waiting for the environment claim.', 504);
  }

  try {
    const [token, image, envVars] = await Promise.all([
      sessionServiceKey(input.sessionId),
      ensureSandboxImage(input.gitProject, { provider: 'daytona' }),
      buildSessionSandboxEnvVars({
        accountId: input.accountId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        userId: input.userId,
        repoUrl: input.gitProject.repoUrl,
        baseRef: input.baseRef,
        agentName: input.agentName,
        llmGatewayEnabled: false,
        // The session branch already exists remotely (pushed at session
        // create); the daemon fetches it instead of assuming branch == base.
        restoreSessionBranch: true,
        defaultBranch: input.gitProject.defaultBranch,
        manifestPath: input.gitProject.manifestPath,
        workspaceMode: input.workspaceMode,
      }),
    ]);
    const provider = getProvider('daytona');
    const environmentId = randomUUID();
    const result = await provider.create({
      accountId: input.accountId,
      userId: input.userId,
      name: `env-${input.sessionId.slice(0, 8)}`,
      sandboxId: environmentId,
      snapshot: image.snapshotName,
      envVars: {
        ...envVars,
        KORTIX_TOKEN: token,
        // The daemon serves /file, /find and /pty without an OpenCode
        // session; the worker is this session's harness, not OpenCode.
        KORTIX_BOOTSTRAP_OPENCODE_SESSION: '0',
      },
    } as never);
    const [active] = await db
      .update(sessionEnvironments)
      .set({
        externalId: result.externalId,
        baseUrl: result.baseUrl || null,
        status: 'active',
        metadata: {
          environmentId,
          snapshot: image.snapshotName,
          providerMetadata: result.metadata ?? {},
        },
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sessionEnvironments.sessionId, input.sessionId))
      .returning();
    return withPreview(active);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(sessionEnvironments)
      .set({
        status: 'error',
        metadata: { lastError: message.slice(0, 500) },
        updatedAt: new Date(),
      })
      .where(eq(sessionEnvironments.sessionId, input.sessionId))
      .catch(() => {});
    if (err instanceof SessionEnvironmentError) throw err;
    throw new SessionEnvironmentError(`Environment provisioning failed: ${message}`, 502);
  }
}

/** Read-only status: never provisions, never resumes. */
export async function readSessionEnvironment(
  sessionId: string,
): Promise<SessionEnvironmentInfo | null> {
  const row = await readRow(sessionId);
  if (!row) return null;
  return withPreview(row);
}

/** Stop the environment box; the row survives for a later resume. */
export async function stopSessionEnvironment(sessionId: string): Promise<SessionEnvironmentInfo | null> {
  const row = await readRow(sessionId);
  if (!row) return null;
  if (row.externalId && row.status === 'active') {
    try {
      const daytona = getDaytona();
      const sandbox = await withTimeout(
        daytona.get(row.externalId),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona get(${row.externalId})`,
      );
      await withTimeout(
        (daytona as unknown as { stop(sandbox: unknown): Promise<unknown> }).stop(sandbox),
        60_000,
        `Daytona stop(${row.externalId})`,
      );
    } catch (err) {
      console.warn(`[session-env] stop of ${row.externalId} failed:`, err);
    }
  }
  const [updated] = await db
    .update(sessionEnvironments)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(eq(sessionEnvironments.sessionId, sessionId))
    .returning();
  return updated
    ? { sessionId, status: updated.status, externalId: updated.externalId, previewUrl: null, previewToken: null }
    : null;
}
