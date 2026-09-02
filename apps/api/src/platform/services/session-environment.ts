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
import { and, eq, sql } from 'drizzle-orm';
import { sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { getDaytona } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
import { ensureSandboxImage } from '../../snapshots/builder';
import type { GitBackedProject } from '../../projects/git';
import { buildSessionSandboxEnvVars } from '../../projects/lib/sessions';
import type { WorkspaceModeV2 } from '@kortix/manifest-schema';
import { getProvider } from '../providers';
import { classifyDaytonaState } from '../providers/daytona-state';
import { decideEnvironmentLiveness, environmentReconcileWrite } from './environment-liveness';
import { endComputeSession, startComputeSession } from '../../billing/services/compute-metering';
import type { SessionEnvironmentInfo } from './session-environment-types';

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
  const meteredId = (current?.metadata as { environmentId?: string } | null)?.environmentId;
  if (meteredId) await endComputeSession(meteredId).catch(() => {});
  const [updated] = await db
    .update(sessionEnvironments)
    .set({
      status,
      ...(clearExternalId ? { externalId: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(sessionEnvironments.sessionId, sessionId), eq(sessionEnvironments.status, 'active')))
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
  void runEnvironmentWork(input, claimed.externalId).catch((err) => {
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
): Promise<{ sessionId: string; status: string; externalId: string | null } | null> {
  if (!existing) {
    const [inserted] = await db
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
    return inserted ?? null;
  }

  const startedAt = existing.updatedAt?.getTime() ?? 0;
  const abandoned =
    existing.status === 'provisioning' && Date.now() - startedAt > PROVISION_STALE_MS;
  if (existing.status !== 'error' && existing.status !== 'stopped' && !abandoned) return null;

  // Conditioned on the status we read, so two callers racing the same
  // transition cannot both win.
  const [reclaimed] = await db
    .update(sessionEnvironments)
    .set({ status: 'provisioning', updatedAt: new Date() })
    .where(
      and(
        eq(sessionEnvironments.sessionId, input.sessionId),
        eq(sessionEnvironments.status, existing.status),
      ),
    )
    .returning();
  return reclaimed ?? null;
}

/**
 * The claimed work itself: resume the box this session already has, or build
 * one. Runs detached from any request, so it reports only through the row.
 */
async function runEnvironmentWork(
  input: EnsureSessionEnvironmentInput,
  externalId: string | null,
): Promise<void> {
  if (externalId) {
    try {
      await resumeEnvironment(externalId);
      // A resumed box burns compute again, and its previous window was closed
      // when it stopped — so open a new one, still against the parent session.
      const resumed = await readRow(input.sessionId);
      const meteredId = (resumed?.metadata as { environmentId?: string } | null)?.environmentId;
      if (meteredId) {
        await startComputeSession({
          sandboxId: meteredId,
          accountId: input.accountId,
          sessionId: input.sessionId,
          actorUserId: input.userId ?? null,
          provider: 'daytona',
          spec: { ...ENVIRONMENT_METERING_SPEC },
          metadata: { workload: 'session-environment', externalId, resumed: true },
        });
      }
      await db
        .update(sessionEnvironments)
        .set({ status: 'active', lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(sessionEnvironments.sessionId, input.sessionId));
      return;
    } catch (err) {
      await markEnvironmentError(input.sessionId, err);
      return;
    }
  }
  await provisionEnvironment(input);
}

async function markEnvironmentError(sessionId: string, err: unknown): Promise<void> {
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
      metadata: sql`coalesce(${sessionEnvironments.metadata}, '{}'::jsonb) || ${JSON.stringify(
        { lastError: message.slice(0, 500) },
      )}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sessionEnvironments.sessionId, sessionId))
    .catch(() => {});
}

async function provisionEnvironment(input: EnsureSessionEnvironmentInput): Promise<void> {
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
      // Environments have no session_sandboxes row, so the box reaper does not
      // manage them yet: the provider's own idle timer is the ONLY stop. Keep
      // it tight (a stopped box resumes on the next ensure) instead of the 12h
      // backstop a reaper-managed session box gets. Metering + reaper tie-in
      // is the recorded fast-follow.
      autoStopInterval: 60,
      envVars: {
        ...envVars,
        KORTIX_TOKEN: token,
        // The daemon serves /file, /find and /pty without an OpenCode
        // session; the worker is this session's harness, not OpenCode.
        KORTIX_BOOTSTRAP_OPENCODE_SESSION: '0',
      },
    } as never);
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
      spec: { ...ENVIRONMENT_METERING_SPEC },
      metadata: { workload: 'session-environment', externalId: result.externalId },
    });
    await db
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
      .where(eq(sessionEnvironments.sessionId, input.sessionId));
  } catch (err) {
    // Nothing is waiting on this promise, so the row IS the error channel:
    // the next ensure re-claims 'error' and tries again.
    await markEnvironmentError(input.sessionId, err);
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

