import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../shared/db';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { provisionSessionSandbox } from '../../platform/services/session-sandbox';
import { WARM_SESSION_METADATA_KEY } from './warm-sessions';
import { createRemoteSessionBranch } from '../git';
import { withProjectGitAuth } from './git';
import { resolveFastBootGitHintWithCache } from './fast-boot-git-hint';
import { projectImageAllowedForSession } from './session-sandbox-metadata';
import { transitionSession } from '../session-lifecycle/status-transitions';
import { projectSessionMetadataMerge } from './session-metadata-merge';
import { mergeSessionSandboxEnv } from './session-runtime-context';
import {
  resolveProjectSnapshotMode,
  resolveProjectSnapshotPinForSession,
} from '../../git-proxy/project-snapshot';
import { buildSessionSandboxEnvVars } from './session-sandbox-env-build';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import type { ProjectRow } from './serializers';
import type { SessionCreateInput, SessionCreatePlan } from './session-create-plan';

/**
 * Fire-and-forget sandbox provisioning for a freshly inserted session, hoisted
 * out of `createProjectSession` verbatim. The dashboard polls the sandbox
 * status endpoint and shows the ConnectingScreen during the long tail.
 */
export async function provisionCreatedSession(
  project: ProjectRow,
  input: SessionCreateInput,
  plan: SessionCreatePlan,
): Promise<void> {
  const {
    sessionId,
    accountId,
    projectId,
    userId,
    baseRef,
    agentName,
    opencodeModel,
    llmGatewayEnabled,
    platformMetaAgent,
    providerName,
    providerLocked,
    sandboxSlug,
    repositoryAccess,
    initialTurn,
  } = plan;
  const body = input.body;

    const tl = new ProvisionTimeline(sessionId, 'session-create');
    try {
      // Resolve git auth and user env concurrently. Git auth is needed for
      // background freshness checks / remote branch publishing, but a warm
      // session can boot from an existing ready snapshot without waiting for it.
      const projectWithGitAuthPromise = withProjectGitAuth(project).then((gitProject) => {
        tl.mark('git-auth');
        return gitProject;
      });
      // Resolve the base tip from the API's existing mirror and package its
      // one-commit scaffold delta. This moves the small object transfer into
      // sandbox creation and removes the slow in-guest Git negotiation.
      // Best-effort + timeout-guarded (never block create): on failure/timeout
      // the hint is omitted → daemon delta-fetches as before. Runs CONCURRENTLY
      // with gitAuth (folded into the env-build chain, not awaited inline).
      let fastBootHintTimeout: ReturnType<typeof setTimeout> | undefined;
      // Default on (KORTIX_FAST_GIT_BOOT_ENABLED): the hint is what lets the
      // daemon boot with ZERO proxied git requests (scaffold + delta) and spawn
      // OpenCode before the checkout. Bounded by the 2 s race below; a miss
      // just means the daemon's fetch fallback.
      const fastBootGitHintPromise =
        config.KORTIX_FAST_GIT_BOOT_ENABLED
        ? Promise.race([
            projectWithGitAuthPromise
              .then((projectWithGitAuth) =>
                resolveFastBootGitHintWithCache(
                  projectWithGitAuth,
                  baseRef,
                  project.metadata,
                ),
              )
              .catch(() => undefined),
            new Promise<undefined>((resolve) => {
              fastBootHintTimeout = setTimeout(() => resolve(undefined), 2_000);
            }),
          ]).finally(() => {
            if (fastBootHintTimeout) clearTimeout(fastBootHintTimeout);
          })
        : Promise.resolve(undefined);
      const envPromise = fastBootGitHintPromise
        .then(async (fastBootGitHint) => {
          // S3 config provider: pin a PREPARED archive for the exact base tip
          // and presign its download descriptor right here (local signing, no
          // bucket call on the create path), or record the miss and queue the
          // build for the next session. One indexed read.
          const projectSnapshotMode = resolveProjectSnapshotMode(project.metadata);
          const projectSnapshot =
            projectSnapshotMode === 'git'
              ? { pin: null, descriptor: null, cache: 'unconfigured' as const }
              : await resolveProjectSnapshotPinForSession({
                  projectId,
                  ref: baseRef,
                  commitSha: fastBootGitHint?.baseSha,
                  repoUrl: project.repoUrl,
                }).catch((err) => {
                  console.warn('[project-snapshot] pin lookup failed; session boots from git', {
                    projectId,
                    sessionId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                  return { pin: null, descriptor: null, cache: 'miss' as const };
                });
          if (projectSnapshotMode !== 'git') {
            tl.mark(`project-snapshot-${projectSnapshot.cache}`);
          }
          return {
            fastBootGitHint,
            projectSnapshotMode,
            projectSnapshotPin: projectSnapshot.pin,
            projectSnapshotDescriptor: projectSnapshot.descriptor,
          };
        })
        .then(({ fastBootGitHint, projectSnapshotMode, projectSnapshotPin, projectSnapshotDescriptor }) =>
          buildSessionSandboxEnvVars({
            accountId,
            projectId,
            sessionId,
            userId,
            repoUrl: project.repoUrl,
            baseRef,
            agentName,
            opencodeModel,
            llmGatewayEnabled,
            platformMetaAgent,
            freshSession: true,
            projectSnapshotMode,
            projectSnapshotPin,
            projectSnapshotDescriptor,
            baseSha: fastBootGitHint?.baseSha,
            gitDeltaBundleBase64: fastBootGitHint?.gitDeltaBundleBase64,
            gitDeltaBundleRemote: fastBootGitHint?.gitDeltaBundleRemote,
            gitDeltaParentSha: fastBootGitHint?.gitDeltaParentSha,
            gitDeltaParentCommitBase64: fastBootGitHint?.gitDeltaParentCommitBase64,
            defaultBranch: project.defaultBranch,
            manifestPath: project.manifestPath,
            repositoryAccess,
          }),
        )
        .then((envVars) => {
          tl.mark('env-vars');
          return envVars;
        });

      const mergeSessionMetadata = async (extra: Record<string, unknown>) => {
        await db
          .update(projectSessions)
          .set({
            metadata: projectSessionMetadataMerge(extra),
            updatedAt: new Date(),
          })
          .where(eq(projectSessions.sessionId, sessionId));
      };

      // Origin branch creation is publishing work, not readiness work. The
      // sandbox now creates the session branch locally from the base checkout
      // immediately, so this remote push runs fully in the background. The
      // metadata writes that record success/failure are pure telemetry —
      // fire-and-forget so they never block the IIFE itself.
      const branchAlreadyCreated =
        body.branch_already_created === true || body.branchAlreadyCreated === true;
      const branchPromise: Promise<void> = !repositoryAccess || branchAlreadyCreated
        ? Promise.resolve()
        : projectWithGitAuthPromise
            .then((projectWithGitAuth) =>
            createRemoteSessionBranch(projectWithGitAuth, sessionId, baseRef),
            )
            .then(() => {
            tl.mark('branch-pushed');
            void mergeSessionMetadata({
                remote_branch: {
                  status: 'ready',
                  branch: sessionId,
                  updated_at: new Date().toISOString(),
                },
            }).catch(() => {});
          });
      branchPromise.catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[projects] Remote branch creation failed for session ${sessionId}:`, err);
        void mergeSessionMetadata({
          remote_branch: {
            status: 'failed',
            branch: sessionId,
            error: message.slice(0, 500),
            updated_at: new Date().toISOString(),
          },
        }).catch(() => {});
      });

      // Not awaited here: provisioning reads it only when it builds the provider
      // input, so the env build overlaps the image check and the token mint.
      const extraEnvVars = envPromise.then((env) => {
        return mergeSessionSandboxEnv(env, input.extraEnvVars);
      });

      const provisionPromise = provisionSessionSandbox({
        sandboxId: sessionId,
        accountId,
        projectId,
        userId,
        agentName,
        allowProjectImage: projectImageAllowedForSession(agentName, repositoryAccess),
        provider: providerName,
        providerLocked,
        metadata: {
          session_id: sessionId,
          project_id: projectId,
          ...(input.metadata ?? {}),
        },
        initialTurn,
        extraEnvVars,
        projectMetadata: project.metadata,
        gitProject: {
          projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath,
          gitAuthToken: null,
        },
        resolveGitProject: async () => projectWithGitAuthPromise,
        baseRef,
        sandboxSlug,
      });

      // provisionSessionSandbox returns once its row is inserted; provider
      // create and remote branch push both continue in detached background work.
      await provisionPromise;
      tl.mark('kicked');
      const sessionStartTimeline = tl.log();
      // Fire-and-forget: the timeline write is pure telemetry. Awaiting it
      // here used to add ~30-80ms of DB round-trip to every session start.
      void mergeSessionMetadata({ session_start_timeline: sessionStartTimeline }).catch(() => {});
    } catch (err) {
      const message = (err as Error)?.message || 'Sandbox provisioning failed';
      console.error(`[projects] Failed to kick off sandbox for session ${sessionId}:`, err);
      try {
        // Merge, never re-write the create-time snapshot: by the time
        // provisioning fails the row may already carry a generated title,
        // remote_branch or the start timeline. A session deleted meanwhile
        // keeps its tombstone.
        await transitionSession('fail', sessionId, {
          error: message,
          metadata: { provisioning_error: message },
        });
      } catch (markErr) {
        console.error(`[projects] Failed to mark session ${sessionId} failed:`, markErr);
      }
      // Surface the failure to the originating channel (Slack) so the thread
      // doesn't sit on a ⏳ until the 30-min GC. No-op for non-channel sessions.
      notifySessionProvisioningFailed(sessionId, message);
    }
  }