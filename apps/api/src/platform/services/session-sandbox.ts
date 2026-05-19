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
} from '../../snapshots/builder';
import { config } from '../../config';
import type { GitBackedProject } from '../../projects/git';

export interface ProvisionSessionSandboxResult {
  row: typeof sessionSandboxes.$inferSelect;
  created: boolean;
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
    },
  };

  // Detach the actual provisioning — the API caller navigates immediately
  // and the dashboard's ConnectingScreen handles the long tail.
  void (async () => {
    let bgExternalId: string | null = null;
    try {
      // Snapshot resolution policy:
      //   1. Look up the latest `ready` snapshot for (project, branch,
      //      provider). If present, boot from that. We never wait for a
      //      build to finish.
      //   2. Fire-and-forget: ask the builder to ensure a snapshot
      //      exists for the *current* tip of the branch. If the tip
      //      moved past the latest-ready commit, this kicks off a new
      //      build in the background; the next session sees it.
      //   3. If no `ready` snapshot exists at all (project just created,
      //      first build hasn't finished, or every prior build failed),
      //      fail the session with a clear message. There is NO shared
      //      DAYTONA_SNAPSHOT fallback — every sandbox boots from its
      //      project's own image.
      const branch = opts.baseRef || opts.gitProject.defaultBranch;
      const latest = await getLatestReadySnapshot(
        opts.gitProject.projectId,
        branch,
        providerName,
      );

      // Kick off "is there a newer commit?" check + lazy build. Don't await.
      void ensureBuildForLatestCommit(opts.gitProject, {
        branch,
        accountId,
        provider: providerName,
        source: 'session-start',
      }).catch((err) => {
        console.warn(
          `[session-sandbox] ensureBuildForLatestCommit failed for ${sandbox.sandboxId}:`,
          err,
        );
      });

      if (!latest || !latest.snapshotId) {
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
          { ...result.metadata, provisioningStage: firstStage?.id, daytonaSandboxId: result.externalId },
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
