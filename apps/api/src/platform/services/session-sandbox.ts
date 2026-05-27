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
  prepareProjectSandboxImage,
} from '../../snapshots/builder';
import { config } from '../../config';
import { ProvisionTimeline } from './provision-timeline';
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
  resolveGitAuthToken?: () => Promise<string | null>;
  baseRef?: string;
}): Promise<ProvisionSessionSandboxResult> {
  const { sandboxId, accountId, projectId, userId, serverType, location } = opts;
  // Resolution order:
  //   1. Explicit per-request `opts.provider` (set by callers that need a
  //      specific runtime, e.g. when restarting an existing sandbox).
  //   2. `config.getDefaultProvider()` — head of ALLOWED_SANDBOX_PROVIDERS.
  const providerName = opts.provider || config.getDefaultProvider();
  const provider = getProvider(providerName);
  const tl = new ProvisionTimeline(sandboxId, 'provision');

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
  tl.mark('sandbox-row');

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
  tl.mark('tokens');

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
    let preparedImage: Awaited<ReturnType<typeof prepareProjectSandboxImage>> | null = null;
    try {
      const branch = opts.baseRef || opts.gitProject.defaultBranch;
      let gitProject = opts.gitProject;
      if (opts.resolveGitAuthToken) {
        const token = await opts.resolveGitAuthToken();
        gitProject = { ...opts.gitProject, gitAuthToken: token };
      }

      preparedImage = await prepareProjectSandboxImage(gitProject, { ref: branch });
      tl.mark('image-prepared');
      providerCreateInput.image = preparedImage.image;
      providerCreateInput.resources = preparedImage.resources;
      console.log(
        `[session-sandbox] Booting ${sandbox.sandboxId} from ad-hoc Daytona image ` +
        `(commit ${preparedImage.commitSha.slice(0, 8)}, branch ${branch}, shortHash ${preparedImage.shortHash})`,
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
      tl.mark(`provider-create:${attempts}x`);
      const timeline = tl.summary();

      const [currentSession] = await db
        .select({ status: projectSessions.status })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sandbox.sandboxId))
        .limit(1);
      if (currentSession?.status === 'stopped') {
        await provider.remove(result.externalId).catch((err) => {
          console.warn(`[session-sandbox] failed to remove stopped session sandbox ${result.externalId}:`, err);
        });
        await db
          .update(sessionSandboxes)
          .set({
            externalId: result.externalId,
            baseUrl: result.baseUrl || null,
            status: 'stopped',
            metadata: {
              ...((sandbox.metadata as Record<string, unknown> | null) ?? {}),
              initStatus: 'failed',
              initAbortedAt: new Date().toISOString(),
              lastInitError: 'Session was stopped before provider create completed',
              provisionTimeline: timeline,
              daytonaSandboxId: result.externalId,
            },
            updatedAt: new Date(),
          })
          .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        tl.mark('row-stopped-before-active');
        tl.log({ provider: providerName, degraded: false, attempts, stoppedBeforeActive: true });
        return;
      }

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
            provisionTimeline: timeline,
            daytonaSandboxId: result.externalId,
            runtimeArtifact: {
              artifactType: providerName === 'daytona' ? 'daytona_adhoc_image' : 'unknown',
              providerArtifactRef: 'adhoc',
              contentHash: preparedImage.contentHash,
              shortHash: preparedImage.shortHash,
              runtimeFingerprint: preparedImage.runtimeFingerprint,
              commitSha: preparedImage.commitSha,
              branch,
              provider: providerName,
              degraded: false,
              headCommitSha: preparedImage.commitSha,
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

      tl.mark('row-active');
      tl.log({ provider: providerName, degraded: false, attempts });
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
    } finally {
      await preparedImage?.cleanup().catch((err) => {
        console.warn(`[session-sandbox] failed to clean up prepared image context for ${sandbox.sandboxId}:`, err);
      });
    }
  })();

  return { row: sandbox, created: true };
}
