/**
 * session-sandbox.ts
 *
 * Provision a sandbox row in `kortix.session_sandboxes` keyed by the caller-
 * supplied UUID (== project session id). Decoupled from the legacy
 * `kortix.sandboxes` /instances table: no billing fields, no sandbox_members
 * roster, no team-membership coupling — project ACL is enforced via
 * `project_members`.
 *
 * Fire-and-forget: returns once the row is inserted in `provisioning` state.
 * Real provider create() runs in a detached IIFE that mirrors the background
 * path in sandbox-cloud.ts.
 */

import { eq } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { createApiKey } from '../../repositories/api-keys';
import { createAccountToken } from '../../repositories/account-tokens';
import {
  getProvider,
  type CreateSandboxOpts,
  type ProviderName,
} from '../providers';
import {
  buildSandboxInitAttemptMetadata,
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  retrySandboxProvisionCreate,
  SANDBOX_INIT_MAX_ATTEMPTS,
} from './sandbox-init-state';
import {
  ensureBuildForLatestCommit,
  getLatestReadySnapshot,
  getReadySnapshotForCommit,
  getSnapshotForCommit,
} from '../../snapshots/builder';
import { config } from '../../config';
import type { GitBackedProject } from '../../projects/git';

const DEFAULT_SNAPSHOT_READY_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_SNAPSHOT_READY_POLL_MS = 5 * 1000;

export interface ProvisionSessionSandboxResult {
  row: typeof sessionSandboxes.$inferSelect;
  created: boolean;
}

function snapshotReadyWaitMs(): number {
  const raw = Number(process.env.KORTIX_SESSION_SNAPSHOT_READY_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SNAPSHOT_READY_WAIT_MS;
}

function snapshotReadyPollMs(waitMs: number): number {
  const raw = Number(process.env.KORTIX_SESSION_SNAPSHOT_READY_POLL_MS);
  const configured = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SNAPSHOT_READY_POLL_MS;
  return Math.max(50, Math.min(configured, Math.max(waitMs, 50)));
}

async function waitForLatestReadySnapshot(
  projectId: string,
  branch: string,
  providerName: ProviderName,
  commitSha?: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getLatestReadySnapshot>>> | null> {
  const waitMs = snapshotReadyWaitMs();
  const deadline = Date.now() + waitMs;
  const maxPollMs = snapshotReadyPollMs(waitMs);

  let attempt = 0;
  for (;;) {
    if (commitSha) {
      const readyForCommit = await getReadySnapshotForCommit(projectId, commitSha, providerName);
      if (readyForCommit?.snapshotId) return readyForCommit;
    }
    const latest = await getLatestReadySnapshot(projectId, branch, providerName);
    if (latest?.snapshotId) return latest;
    if (commitSha) {
      const attempted = await getSnapshotForCommit(projectId, commitSha, providerName);
      if (attempted?.status === 'failed') {
        throw new Error(
          attempted.error
            ? `Project sandbox build failed: ${attempted.error}`
            : `Project sandbox build failed for commit ${commitSha.slice(0, 8)}`,
        );
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    // Ramp the poll: a content-hash cache hit becomes ready in ~3-5s, so start
    // tight (500ms) and back off to the configured max instead of waiting a
    // flat 5s step and adding dead time to the common warm path.
    const rampMs = Math.min(maxPollMs, 500 * 2 ** Math.min(attempt, 4));
    attempt++;
    await new Promise((resolve) => setTimeout(resolve, Math.min(rampMs, remaining)));
  }
}

function stringMetadataValue(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export async function provisionSessionSandbox(opts: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  userId: string;
  provider?: ProviderName;
  serverType?: string;
  location?: string;
  metadata?: Record<string, unknown>;
  /**
   * Extra env vars injected into the sandbox at provider create-time. These
   * land in the Daytona snapshot's environment so its boot script can read
   * them (e.g. `KORTIX_PROJECT_REPO_URL`, `KORTIX_PROJECT_BRANCH`).
   */
  extraEnvVars?: Record<string, string>;
  /**
   * Project + ref the session boots against. Required: every session
   * sandbox boots from the project's own per-project snapshot
   * (`kortix-snap-…`). There is no shared platform-wide fallback — if
   * no `ready` snapshot exists yet for the project's default branch,
   * the session fails with a clear "still building" error. See
   * apps/api/src/snapshots/builder.ts.
   *
   * `baseRef` is used to pick the *branch* whose latest ready snapshot
   * we boot from; when omitted, defaults to `gitProject.defaultBranch`.
   */
  gitProject: GitBackedProject;
  baseRef?: string;
}): Promise<ProvisionSessionSandboxResult> {
  const { sandboxId, accountId, projectId, userId, serverType, location } = opts;
  // Resolution order:
  //   1. Explicit per-request `opts.provider` (set by callers that need a
  //      specific runtime, e.g. when restarting an existing sandbox).
  //   2. `config.getDefaultProvider()` — head of ALLOWED_SANDBOX_PROVIDERS.
  const providerName = opts.provider || config.getDefaultProvider();
  const provider = getProvider(providerName);

  const [sandbox] = await db
    .insert(sessionSandboxes)
    .values({
      sandboxId,
      sessionId: sandboxId,
      accountId,
      projectId,
      provider: providerName,
      externalId: null,
      status: 'provisioning',
      baseUrl: null,
      config: {},
      metadata: {
        // Session sandboxes are immutable per-session, so no autoUpdate
        // policy is recorded — the legacy auto-update loop is gone.
        ...(opts.metadata ?? {}),
        initStatus: 'pending',
        initAttempts: 0,
        initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
        healthStatus: 'unknown',
      },
    })
    .returning();

  const sandboxKey = await createApiKey({
    sandboxId: sandbox.sandboxId,
    accountId,
    title: 'Sandbox Token',
    type: 'sandbox',
  });

  // Executor token — acts AS the launching user, scoped to this project, so the
  // Executor gateway enforces that user's connector sharing/policies. Resolved
  // server-side; the sandbox never holds any third-party credential.
  let executorToken: string | null = null;
  try {
    const tok = await createAccountToken({
      accountId,
      userId,
      projectId,
      name: `Executor Session ${sandboxId.slice(0, 8)}`,
    });
    executorToken = tok.secretKey;
  } catch (err) {
    console.warn(`[session-sandbox] failed to mint executor token for ${projectId}:`, err);
  }

  const sandboxName = `session-${sandboxId.slice(0, 8)}`;
  const providerCreateInput: CreateSandboxOpts = {
    accountId,
    userId,
    name: sandboxName,
    serverType,
    location,
    envVars: {
      ...(opts.extraEnvVars ?? {}),
      KORTIX_TOKEN: sandboxKey.secretKey,
      ...(executorToken ? { KORTIX_EXECUTOR_TOKEN: executorToken } : {}),
    },
  };

  // Detach the actual provisioning — the API caller navigates immediately
  // and the dashboard's ConnectingScreen handles the long tail.
  void (async () => {
    let bgExternalId: string | null = null;
    try {
      // Snapshot resolution policy:
      //   1. Ask the builder for the current tip of the requested ref. If
      //      that commit is already ready, boot it immediately. If another
      //      ref built the same commit, this still works because we resolve
      //      by commit/provider instead of branch/provider only.
      //   2. If the current tip is building or was just queued, keep this
      //      provisioning worker alive until that commit has a ready image.
      //   3. Only use latest-ready-by-branch as a compatibility fallback
      //      when the builder cannot return a commit SHA. We do not boot an
      //      older branch image while a newer current-tip build is pending.
      //
      // There is NO shared DAYTONA_SNAPSHOT fallback — every sandbox boots
      // from its project's own image.
      const branch = opts.baseRef || opts.gitProject.defaultBranch;
      const build = await ensureBuildForLatestCommit(opts.gitProject, {
        branch,
        accountId,
        provider: providerName,
        source: 'session-start',
      });
      if (build.status === 'failed-to-start') {
        throw new Error(`Project sandbox build failed to start: ${build.error ?? 'unknown error'}`);
      }

      let latest = build.commitSha
        ? await getReadySnapshotForCommit(opts.gitProject.projectId, build.commitSha, providerName)
        : null;

      if (!latest?.snapshotId && build.commitSha) {
        latest = await waitForLatestReadySnapshot(
          opts.gitProject.projectId,
          branch,
          providerName,
          build.commitSha,
        );
      } else if (!build.commitSha) {
        latest = await waitForLatestReadySnapshot(
          opts.gitProject.projectId,
          branch,
          providerName,
        );
      }

      if (!latest?.snapshotId) {
        throw new Error(
          `Project sandbox is still building. ` +
          `This is a one-time setup that runs the first time a project is created (or after every failed build is retried). ` +
          `Please retry in ~1 minute.`,
        );
      }
      providerCreateInput.snapshot = latest.snapshotId;
      console.log(
        `[session-sandbox] Booting ${sandbox.sandboxId} from ${latest.snapshotId} ` +
        `(commit ${latest.commitSha.slice(0, 8)}, branch ${branch})`,
      );

      const firstStage = provider.provisioning.stages[0];
      const { result, attempts } = await retrySandboxProvisionCreate(provider, providerCreateInput, {
        onAttemptStart: async (attempt) => {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: buildSandboxInitAttemptMetadata(
                sandbox.metadata as Record<string, unknown> | null,
                attempt,
                attempt === 1 ? 'provisioning' : 'retrying',
                firstStage?.id,
                attempt === 1 ? firstStage?.message : `Retrying initialization (${attempt}/${SANDBOX_INIT_MAX_ATTEMPTS})…`,
              ),
              updatedAt: new Date(),
            })
            .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        },
        onAttemptFailure: async (attempt, error, willRetry) => {
          await db
            .update(sessionSandboxes)
            .set({
              ...(willRetry ? { status: 'provisioning' as const } : { status: 'error' as const }),
              metadata: buildSandboxInitFailureMetadata(
                sandbox.metadata as Record<string, unknown> | null,
                error,
                attempt,
                willRetry,
              ),
              updatedAt: new Date(),
            })
            .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        },
      });
      bgExternalId = result.externalId;

      // Async providers leave the row at 'provisioning' so the dashboard
      // poller can flip it to 'active' once port 8000 is reachable. Sync
      // providers (none today) would be ready immediately on create.
      const finishUpdate: Partial<typeof sessionSandboxes.$inferInsert> = {
        externalId: result.externalId,
        baseUrl: result.baseUrl || null,
        metadata: buildSandboxInitSuccessMetadata(
          sandbox.metadata as Record<string, unknown> | null,
          {
            ...result.metadata,
            provisioningStage: firstStage?.id,
            daytonaSandboxId: result.externalId,
            runtimeArtifact: {
              artifactType: providerName === 'daytona' ? 'daytona_snapshot' : 'unknown',
              providerArtifactRef: latest.snapshotId,
              snapshotRowId: latest.snapshotRowId,
              contentHash: stringMetadataValue(latest.metadata, 'contentHash'),
              shortHash: stringMetadataValue(latest.metadata, 'shortHash'),
              runtimeFingerprint: stringMetadataValue(latest.metadata, 'runtimeFingerprint'),
              commitSha: latest.commitSha,
              branch,
              provider: providerName,
            },
          },
          attempts,
        ),
        config: { serviceKey: sandboxKey.secretKey },
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      };
      if (!provider.provisioning.async) {
        finishUpdate.status = 'active';
      } else {
        // For cloud providers we still flip to active here because the legacy
        // provision-poller (which only handles JustAVPS) doesn't see this
        // table; the frontend's own readiness poller validates port 8000.
        finishUpdate.status = 'active';
      }

      await db
        .update(sessionSandboxes)
        .set(finishUpdate)
        .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));

      // Mirror sandbox readiness onto the project_sessions row so the
      // sidebar's status dot stops spinning. session_id == sandbox_id by
      // construction, so the lookup is direct.
      await db
        .update(projectSessions)
        .set({
          status: 'running',
          sandboxUrl: result.baseUrl || null,
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.sessionId, sandbox.sandboxId))
        .catch(() => {});

      console.log(
        `[session-sandbox] Provisioned ${sandbox.sandboxId} via ${providerName} ` +
        `(external: ${result.externalId}) for account ${accountId}`,
      );
    } catch (bgErr) {
      console.error(`[session-sandbox] Background provisioning failed for ${sandbox.sandboxId}:`, bgErr);
      const bgMessage = bgErr instanceof Error ? bgErr.message : String(bgErr);

      if (bgExternalId) {
        try {
          await provider.remove(bgExternalId);
        } catch (cleanupErr) {
          console.error(`[session-sandbox] Failed to clean up provider resource ${bgExternalId}:`, cleanupErr);
        }
      }

      try {
        await db
          .update(sessionSandboxes)
          .set({
            status: 'error',
            metadata: {
              ...buildSandboxInitFailureMetadata(
                sandbox.metadata as Record<string, unknown> | null,
                bgErr,
                SANDBOX_INIT_MAX_ATTEMPTS,
                false,
              ),
              errorMessage: `Provisioning failed via ${providerName}.`,
              lastProvisioningError: bgMessage.slice(0, 500),
            },
            updatedAt: new Date(),
          })
          .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        await db
          .update(projectSessions)
          .set({ status: 'failed', error: bgMessage.slice(0, 500), updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sandbox.sandboxId))
          .catch(() => {});
      } catch (markErr) {
        console.error(`[session-sandbox] Failed to mark sandbox ${sandbox.sandboxId} as error:`, markErr);
      }
    }
  })();

  return { row: sandbox, created: true };
}
