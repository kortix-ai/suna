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
import { getOrBuildSnapshot } from '../../snapshots/builder';
import { getOrBuildSnapshot, SnapshotBuildError } from '../../snapshots/builder';
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
   * When present, the per-project snapshot builder runs before provider
   * create so the session boots from a Dockerfile-built image instead of
   * the shared platform default. Caller supplies the GitBackedProject
   * (cheap — just the fields already loaded for the session); the
   * builder handles caching + lazy build.
   *
   * `baseRef` pins the build to a commit; when omitted, defaults to
   * `gitProject.defaultBranch`.
   */
  gitProject?: GitBackedProject;
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
      // Per-project snapshot resolution. The builder is provider-aware
      // (see snapshots/builder.ts); we pass the provider through so a
      // future runtime can land its own build path without re-threading
      // callers. When the builder throws (build failed, project
      // mis-configured), we surface a clear error on the session row.
      if (opts.gitProject) {
        try {
          const resolution = await getOrBuildSnapshot(opts.gitProject, {
            ref: opts.baseRef,
            accountId,
            provider: providerName,
          });
          providerCreateInput.snapshot = resolution.daytonaName;
          console.log(
            `[session-sandbox] Resolved snapshot for ${sandbox.sandboxId}: ` +
            `${resolution.daytonaName} (commit ${resolution.commitSha.slice(0, 8)}, ` +
            `${resolution.built ? 'built' : 'cached'})`,
          );
        } catch (snapErr) {
          // Per-project snapshot building is incomplete (kortix-agent /
          // kortix-entrypoint binaries aren't injected into the build context
          // yet — see snapshots/builder.ts). Fall back to the shared
          // DAYTONA_SNAPSHOT so sessions still boot locally.
          console.warn(
            `[session-sandbox] Snapshot resolution errored for ${sandbox.sandboxId}, ` +
            `falling back to shared snapshot:`,
            snapErr,
          );
        }
      }

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
