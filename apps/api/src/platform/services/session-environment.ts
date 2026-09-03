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
 *   does NOT wait — `ensure` answers with the current status and the caller
 *   polls, because the provision outlives any request. No advisory locks.
 * - **The environment is a separate runtime principal.** Its KORTIX_TOKEN has
 *   the same session grant but a different runtime UUID and token row. The API
 *   can distinguish worker callbacks from environment callbacks and revoke
 *   either box without changing the other.
 * - **The worker reaches it over the provider edge, not the session proxy.**
 *   The ensure response carries a preview URL + token; worker↔environment
 *   traffic never transits the control plane (gate G0: per-call proxied HTTP
 *   is the tax the split exists to avoid).
 * - **OpenCode is not required.** The box boots with
 *   KORTIX_BOOTSTRAP_OPENCODE_SESSION=0 — the daemon serves files/find/pty
 *   without an OpenCode session.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { projectSessions, sessionEnvironments } from '@kortix/db';
import type { WorkspaceModeV2 } from '@kortix/manifest-schema';
import { and, eq, sql } from 'drizzle-orm';
import { endComputeSession, startComputeSession } from '../../billing/services/compute-metering';
import type { GitBackedProject } from '../../projects/git';
import { buildSessionSandboxEnvVars } from '../../projects/lib/sessions';
import { revokeAccountToken } from '../../repositories/account-tokens';
import { getDaytona } from '../../shared/daytona';
import { db } from '../../shared/db';
import { withTimeout } from '../../shared/with-timeout';
import { ensureSandboxImage } from '../../snapshots/builder';
import { getProvider } from '../providers';
import { classifyDaytonaState } from '../providers/daytona-state';
import { decideEnvironmentLiveness, environmentReconcileWrite } from './environment-liveness';
import type { SessionEnvironmentInfo } from './session-environment-types';
import { mintSessionRuntimeToken } from './session-runtime-token';

const PROVIDER_CALL_TIMEOUT_MS = 30_000;
/**
 * What an environment box costs, for metering. It is created from the
 * project's own image with no explicit size, so it lands on the platform
 * default — the same 2 vCPU / 4 GB / 20 GB `session-sandbox.ts` meters an
 * unsized session box at.
 */
const ENVIRONMENT_METERING_SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };
/** A claim whose owner died mid-provision is re-claimable after this. */
const PROVISION_STALE_MS = 5 * 60_000;

export type { SessionEnvironmentInfo } from './session-environment-types';

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
  config?: unknown;
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
        (
          sandbox as unknown as {
            getPreviewLink(port: number): Promise<{ url: string; token?: string }>;
          }
        ).getPreviewLink(8000),
        PROVIDER_CALL_TIMEOUT_MS,
        `Daytona getPreviewLink(${row.externalId}:8000)`,
      );
      previewUrl = preview.url.replace(/\/+$/, '');
      previewToken = preview.token ?? null;
    } catch (err) {
      console.warn(`[session-env] preview link for ${row.externalId} failed:`, err);
    }
  }
  const config = (row.config ?? {}) as { rpcSecret?: string; serviceKey?: string };
  return {
    sessionId: row.sessionId,
    status: row.status,
    externalId: row.externalId,
    previewUrl,
    previewToken,
    rpcSecret: row.status === 'active' ? (config.rpcSecret ?? config.serviceKey ?? null) : null,
  };
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

/**
 * The provider's opinion of a box, normalized — never throws.
 *
 * An unreachable provider must read as `unknown`, not as a failure: `unknown`
 * deliberately means "we could not determine the state right now" and
 * `decideEnvironmentLiveness` refuses to act on it.
 */
async function readBoxStatus(externalId: string) {
  try {
    const sandbox = await withTimeout(
      getDaytona().get(externalId),
      PROVIDER_CALL_TIMEOUT_MS,
      `Daytona get(${externalId})`,
    );
    return classifyDaytonaState((sandbox as unknown as { state?: unknown }).state);
  } catch (err) {
    console.warn(`[session-env] state read for ${externalId} failed:`, err);
    return 'unknown' as const;
  }
}

/** Write what the provider actually reports, so the claim path can act on it. */
async function reconcileEnvironmentStatus(
  sessionId: string,
  write: { status: 'stopped' | 'error'; clearExternalId: boolean },
) {
  const { status, clearExternalId } = write;
  console.log(
    `[session-env] reconciling ${sessionId}: active -> ${status}` +
      `${clearExternalId ? ' (box gone, clearing external_id so it is rebuilt)' : ''}`,
  );
  // The meter tracked a box that is not running. Closing it here keeps the
  // window honest; a resume opens a fresh one.
  const current = await readRow(sessionId);
  const meteredId =
    current?.environmentId ??
    (current?.metadata as { environmentId?: string } | null)?.environmentId;
  if (meteredId) await endComputeSession(meteredId).catch(() => {});
  const [updated] = await db
    .update(sessionEnvironments)
    .set({
      status,
      ...(clearExternalId ? { externalId: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(sessionEnvironments.sessionId, sessionId), eq(sessionEnvironments.status, 'active')),
    )
    .returning();
  // A concurrent writer may have moved it already; re-read rather than assume.
  return updated ?? (await readRow(sessionId));
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
 * Idempotent and NON-BLOCKING: reports the session's environment as it stands
 * right now, and starts the provision or resume out of band when one is owed.
 *
 * It used to await the provision inside the request, and nothing could make
 * that work. The API kills every request at 25 s (`middleware/request-deadline`),
 * a cold Daytona box takes far longer than that, and the loser of the claim
 * waited another 120 s on top. So the FIRST compute tool call of every pi
 * session got 503 after 503 until the worker's 180 s budget ran out: `write`
 * spun for three minutes and then failed, on a session that was otherwise
 * healthy. The worker is already a poller — `LazyKortixEnv.attach` re-asks
 * every 2 s until it sees `active` — so the honest answer to "ensure" is the
 * current status, immediately, plus the work started.
 *
 * Every terminal failure still marks the row 'error'; a later ensure re-claims
 * it and retries.
 */
export async function ensureSessionEnvironment(
  input: EnsureSessionEnvironmentInput,
): Promise<SessionEnvironmentInfo> {
  let existing = await readRow(input.sessionId);
  if (existing?.status === 'active' && existing.externalId) {
    // Ask the provider before trusting the column. Nothing reconciles it —
    // `applyStoppedState` cannot reach a row with no `session_sandboxes` entry
    // — while `autoStopInterval: 60` powers the box off after an idle hour. A
    // row left reading 'active' over a stopped box wedges the session for good,
    // because `claimEnvironmentWork` re-claims only 'error'/'stopped'/stale
    // 'provisioning'. See `environment-liveness.ts`.
    const action = decideEnvironmentLiveness(await readBoxStatus(existing.externalId));
    const write = environmentReconcileWrite(action);
    if (!write) return withPreview(existing);
    // Write the truth, then fall through: the claim path below already knows
    // how to resume a 'stopped' row and rebuild an 'error' one. Clearing
    // external_id on a REMOVED box is what makes "rebuild" happen at all —
    // `runEnvironmentWork` resumes whenever that column is set.
    existing = await reconcileEnvironmentStatus(input.sessionId, write);
  }

  const claimed = await claimEnvironmentWork(input, existing);
  if (!claimed) {
    // Someone else owns the work. Report how far it has got and let the caller
    // poll — waiting here is what the deadline kills.
    const row = (await readRow(input.sessionId)) ?? existing;
    if (!row) throw new SessionEnvironmentError('Environment claim vanished; retry.', 409);
    return withPreview(row);
  }

  // Out of band on purpose (see above). Nothing awaits this; the row is the
  // only channel, which is why every exit path below writes to it.
  const provisionAttemptId = (claimed.metadata as { provisionAttemptId?: unknown } | null)
    ?.provisionAttemptId;
  if (typeof provisionAttemptId !== 'string') {
    throw new SessionEnvironmentError('Environment claim has no provision attempt id.', 500);
  }
  void runEnvironmentWork(
    input,
    claimed.externalId,
    claimed.environmentId,
    provisionAttemptId,
  ).catch((err) => {
    console.error('[session-env] environment work failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return withPreview(claimed);
}

/**
 * Win the right to provision, or return null so the winner does it.
 *
 * Claims a session that has no environment (insert), one whose last attempt
 * failed ('error'), and a 'stopped' one (which resumes rather than provisions).
 * It also re-claims a 'provisioning' row whose owner has gone quiet for
 * `PROVISION_STALE_MS`: with the work no longer pinned to a live request, a
 * process that dies mid-provision would otherwise wedge that session forever,
 * because nothing else ever re-claims a 'provisioning' row.
 */
async function claimEnvironmentWork(
  input: EnsureSessionEnvironmentInput,
  existing: Awaited<ReturnType<typeof readRow>>,
): Promise<{
  sessionId: string;
  status: string;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  environmentId: string | null;
} | null> {
  const provisionAttemptId = randomUUID();
  if (!existing) {
    const [inserted] = await db
      .insert(sessionEnvironments)
      .values({
        sessionId: input.sessionId,
        environmentId: randomUUID(),
        accountId: input.accountId,
        projectId: input.projectId,
        provider: 'daytona',
        status: 'provisioning',
        metadata: { provisionAttemptId },
      })
      .onConflictDoNothing()
      .returning();
    return inserted ?? null;
  }

  const startedAt = existing.updatedAt?.getTime() ?? 0;
  const abandoned =
    existing.status === 'provisioning' && Date.now() - startedAt > PROVISION_STALE_MS;
  if (existing.status !== 'error' && existing.status !== 'stopped' && !abandoned) return null;
  const legacyEnvironmentId = (existing.metadata as { environmentId?: string } | null)
    ?.environmentId;
  const reusesProviderBox = Boolean(existing.externalId);
  const environmentId = reusesProviderBox
    ? (existing.environmentId ?? legacyEnvironmentId ?? randomUUID())
    : randomUUID();

  // Conditioned on the status we read, so two callers racing the same
  // transition cannot both win.
  const [reclaimed] = await db
    .update(sessionEnvironments)
    .set({
      status: 'provisioning',
      environmentId,
      metadata: sql`coalesce(${sessionEnvironments.metadata}, '{}'::jsonb) || ${JSON.stringify({
        provisionAttemptId,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionEnvironments.sessionId, input.sessionId),
        eq(sessionEnvironments.status, existing.status),
      ),
    )
    .returning();
  const oldCredentialTokenId = (existing.config as { credentialTokenId?: string } | null)
    ?.credentialTokenId;
  if (
    reclaimed &&
    oldCredentialTokenId &&
    existing.environmentId !== environmentId &&
    !reusesProviderBox
  ) {
    await revokeAccountToken(oldCredentialTokenId, existing.accountId, existing.projectId).catch(
      () => {},
    );
  }
  return reclaimed ?? null;
}

/**
 * The claimed work itself: resume the box this session already has, or build
 * one. Runs detached from any request, so it reports only through the row.
 */
async function runEnvironmentWork(
  input: EnsureSessionEnvironmentInput,
  externalId: string | null,
  environmentId: string | null,
  provisionAttemptId: string,
): Promise<void> {
  if (externalId) {
    try {
      await resumeEnvironment(externalId);
      const claimed = await readRow(input.sessionId);
      const meteredId =
        claimed?.environmentId ??
        (claimed?.metadata as { environmentId?: string } | null)?.environmentId;
      const activated = await activateEnvironmentClaim({
        sessionId: input.sessionId,
        provisionAttemptId,
        externalId,
      });
      if (!activated) {
        await removeUnownedEnvironment(externalId, meteredId);
        return;
      }
      if (meteredId) {
        await startComputeSession({
          sandboxId: meteredId,
          accountId: input.accountId,
          sessionId: input.sessionId,
          actorUserId: input.userId ?? null,
          provider: 'daytona',
          workloadType: 'environment',
          spec: { ...ENVIRONMENT_METERING_SPEC },
          metadata: { workload: 'session-environment', externalId, resumed: true },
        });
      }
      if (!(await environmentClaimIsOwned(input.sessionId, provisionAttemptId, externalId))) {
        await removeUnownedEnvironment(externalId, meteredId);
      }
      return;
    } catch (err) {
      await markEnvironmentError(input.sessionId, provisionAttemptId, err);
      return;
    }
  }
  if (!environmentId) {
    await markEnvironmentError(
      input.sessionId,
      provisionAttemptId,
      new Error('Environment claim has no runtime id.'),
    );
    return;
  }
  await provisionEnvironment(input, environmentId, provisionAttemptId);
}

async function markEnvironmentError(
  sessionId: string,
  provisionAttemptId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(sessionEnvironments)
    .set({
      status: 'error',
      // MERGE, never replace. A whole-object assign here wiped `environmentId`
      // — the compute ledger's key for this box — along with `snapshot` and
      // `providerMetadata`. With the key gone, `endComputeSession` can never
      // close the open window and the resume path opens none, so one error left
      // an environment running and metered nowhere, permanently.
      metadata: sql`coalesce(${sessionEnvironments.metadata}, '{}'::jsonb) || ${JSON.stringify({
        lastError: message.slice(0, 500),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionEnvironments.sessionId, sessionId),
        sql`${sessionEnvironments.metadata}->>'provisionAttemptId' = ${provisionAttemptId}`,
      ),
    )
    .catch(() => {});
}

async function activateEnvironmentClaim(input: {
  sessionId: string;
  provisionAttemptId: string;
  externalId: string;
  baseUrl?: string | null;
  metadata?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) {
  const [activated] = await db
    .update(sessionEnvironments)
    .set({
      externalId: input.externalId,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      status: 'active',
      ...(input.metadata
        ? {
            metadata: sql`coalesce(${sessionEnvironments.metadata}, '{}'::jsonb) || ${JSON.stringify(
              input.metadata,
            )}::jsonb`,
          }
        : {}),
      ...(input.config
        ? {
            config: sql`coalesce(${sessionEnvironments.config}, '{}'::jsonb) || ${JSON.stringify(
              input.config,
            )}::jsonb`,
          }
        : {}),
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionEnvironments.sessionId, input.sessionId),
        eq(sessionEnvironments.status, 'provisioning'),
        sql`${sessionEnvironments.metadata}->>'provisionAttemptId' = ${input.provisionAttemptId}`,
        sql`exists (
          select 1 from ${projectSessions}
          where ${projectSessions.sessionId} = ${input.sessionId}
            and ${projectSessions.status} in ('queued', 'branching', 'provisioning', 'running')
            and ${projectSessions.metadata}->>'deletedAt' is null
        )`,
      ),
    )
    .returning();
  return activated ?? null;
}

async function environmentClaimIsOwned(
  sessionId: string,
  provisionAttemptId: string,
  externalId: string,
): Promise<boolean> {
  const row = await readRow(sessionId);
  return (
    row?.status === 'active' &&
    row.externalId === externalId &&
    (row.metadata as { provisionAttemptId?: unknown } | null)?.provisionAttemptId ===
      provisionAttemptId
  );
}

async function removeUnownedEnvironment(externalId: string, meteredId?: string): Promise<void> {
  if (meteredId) await endComputeSession(meteredId).catch(() => {});
  await getProvider('daytona')
    .remove(externalId)
    .catch((err) =>
      console.warn(
        `[session-env] failed to remove unowned box ${externalId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

async function provisionEnvironment(
  input: EnsureSessionEnvironmentInput,
  environmentId: string,
  provisionAttemptId: string,
): Promise<void> {
  let credential: { tokenId: string; secretKey: string } | null = null;
  let credentialPublished = false;
  const rpcSecret = randomBytes(32).toString('base64url');
  try {
    const [image, envVars] = await Promise.all([
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
    credential = await mintSessionRuntimeToken({
      accountId: input.accountId,
      userId: input.userId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      runtimeKind: 'environment',
      runtimeId: environmentId,
      agentName: input.agentName,
      gitProject: input.gitProject,
    });
    const provider = getProvider('daytona');
    const result = await provider.create({
      accountId: input.accountId,
      userId: input.userId,
      name: `env-${input.sessionId.slice(0, 8)}`,
      sandboxId: environmentId,
      workloadType: 'environment',
      snapshot: image.snapshotName,
      // The provider idle timer is the environment's liveness ceiling. Keep it
      // tight because the billing sweep caps accrual at the last observation
      // plus this interval. A stopped box resumes on the next ensure.
      autoStopInterval: 60,
      envVars: {
        ...envVars,
        KORTIX_TOKEN: credential.secretKey,
        KORTIX_ENV_RPC_SECRET: rpcSecret,
        // The daemon serves /file, /find and /pty without an OpenCode
        // session; the worker is this session's harness, not OpenCode.
        KORTIX_BOOTSTRAP_OPENCODE_SESSION: '0',
      },
    } as never);
    const activated = await activateEnvironmentClaim({
      sessionId: input.sessionId,
      provisionAttemptId,
      externalId: result.externalId,
      baseUrl: result.baseUrl || null,
      config: {
        serviceKey: credential.secretKey,
        credentialTokenId: credential.tokenId,
        rpcSecret,
      },
      metadata: {
        snapshot: image.snapshotName,
        providerMetadata: result.metadata ?? {},
      },
    });
    if (!activated) {
      await revokeAccountToken(credential.tokenId, input.accountId, input.projectId).catch(
        () => {},
      );
      await removeUnownedEnvironment(result.externalId, environmentId);
      return;
    }
    credentialPublished = true;
    // Meter the environment AS PART OF THE PARENT SESSION: the compute row
    // carries the session's id, so its seconds and cost roll into that
    // session's line rather than appearing as a second, unattributed box.
    // Until now an environment was metered NOWHERE — it has no
    // session_sandboxes row, which is what every billing join keys on, so a
    // pi session's compute was invisible the moment the work moved into it.
    await startComputeSession({
      sandboxId: environmentId,
      accountId: input.accountId,
      sessionId: input.sessionId,
      actorUserId: input.userId ?? null,
      provider: 'daytona',
      workloadType: 'environment',
      spec: { ...ENVIRONMENT_METERING_SPEC },
      metadata: { workload: 'session-environment', externalId: result.externalId },
    });
    if (!(await environmentClaimIsOwned(input.sessionId, provisionAttemptId, result.externalId))) {
      await revokeAccountToken(credential.tokenId, input.accountId, input.projectId).catch(
        () => {},
      );
      await removeUnownedEnvironment(result.externalId, environmentId);
    }
  } catch (err) {
    if (credential && !credentialPublished) {
      await revokeAccountToken(credential.tokenId, input.accountId, input.projectId).catch(
        () => {},
      );
    }
    // Nothing is waiting on this promise, so the row IS the error channel:
    // the next ensure re-claims 'error' and tries again.
    await markEnvironmentError(input.sessionId, provisionAttemptId, err);
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

// Teardown lives in `session-environment-teardown.ts`: it needs a provider
// handle, the metering ledger and one table, while everything above needs the
// image builder, the git layer and the agent-config compiler. Re-exported here
// so the split is invisible to callers.
export {
  deleteSessionEnvironment,
  stopSessionEnvironment,
} from './session-environment-teardown';
