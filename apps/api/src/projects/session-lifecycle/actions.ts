import { sessionAttachmentStore } from '../lib/session-attachments';
import { pauseComputeSession } from '../../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../../config';
import { logger } from '../../lib/logger';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';
import { and, eq, sql } from 'drizzle-orm';
import { revokeSessionConnectorTokens } from '../../repositories/account-tokens';
import { revokeAllPublicSharesForSession } from '../../shared/session-public-shares';
import {
  legacyRehydrateSpec,
  rehydrateSessionChat,
} from '../legacy-migration-rehydrate';
import { withProjectGitAuth } from '../lib/git';
import { scheduleSessionConfigConvergence } from '../lib/session-config-convergence';
import { refreshSandboxRuntimeAssets } from '../lib/sandbox-runtime-refresh';
import { allocateSessionRuntime } from '../lib/session-runtime-allocator';
import {
  projectImageAllowedForSession,
  sandboxSlugFromSessionMetadata,
  repositoryAccessFromSessionMetadata,
} from '../lib/session-sandbox-metadata';
import {
  buildSessionSandboxEnvVars,
  sandboxCallbackDeadTunnelReason,
  sandboxCallbackUnreachableReason,
} from '../lib/sessions';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { isMissingRuntimeError } from '../routes/shared';
import { invalidateProviderCache } from '../../sandbox-proxy';
import {
  claimInPlaceRuntimeRecovery,
  markInPlaceRuntimeRecoveryAccepted,
  parkEstablishedRuntime,
  preserveEstablishedRuntime,
  runtimeLossVerdict,
  retireUnmaterializedRuntime,
  RUNTIME_IDENTITY_ERROR,
  RUNTIME_IDENTITY_UNAVAILABLE,
} from '../runtime-identity';
import { inspectSandboxRuntime } from '../runtime-inspection';
import { prepareInitialSandboxTurn } from '../sandbox-turn-lifecycle';
import { claimInPlaceRestart } from './runtime-restart-claim';
import { transitionSandbox, transitionSession } from './status-transitions';
import {
  DELETED_SESSION_CLEARED_KEYS,
  PROVIDER_REMOVAL_PENDING_KEY,
  attemptArchivedBoxRemoval,
} from '../reaping/archived-box-removal';
import {
  RUNTIME_RESTART_LEASE_MS,
  restartClaimIsActive,
} from './runtime-restart-fence';

/** The in-place restart claim. The restart finalize and failure writes drop it. */
const RESTART_CLAIM_KEYS = [
  'runtimeRestartId',
  'runtimeRestartStartedAt',
  'runtimeRestartLeaseExpiresAt',
  'runtimeRestartPhase',
] as const;

export async function deleteSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  userId: string;
}): Promise<{ ok: true } | { error: string; status: number }> {
  const { projectId, sessionId, accountId, userId } = input;
  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
      ),
    )
    .limit(1);

  // Release the session's prompt attachments before the tombstone, so a failed
  // release fails a delete that can still be retried. The cleanup sweep then
  // removes each unreferenced object before its metadata.
  const { releasePromptAttachmentsForSession } = await import('../prompt-attachments');
  await releasePromptAttachmentsForSession({ sessionId, projectId, accountId });

  const deletedAt = new Date();
  // Merged in SQL: the tombstone must not write back a metadata object read
  // earlier, which would erase any key a concurrent writer added since.
  const tombstone = { deletedAt: deletedAt.toISOString(), deletedBy: userId };
  const deleted = await transitionSession('delete', sessionId, {
    at: deletedAt,
    metadata: tombstone,
    guard: and(
      eq(projectSessions.projectId, projectId),
      eq(projectSessions.accountId, accountId),
    ),
  });

  if (!deleted) return { error: 'Not found', status: 404 };

  await Promise.resolve().then(() => sessionAttachmentStore().removeSession(projectId, sessionId)).catch((error) => {
    console.error('[session-attachments] cleanup failed', { projectId, sessionId, error });
  });

  // Public links end with the session. `resolvePublicShare` already refuses a
  // tombstoned session (410); this makes the owner's share list say so too.
  await Promise.resolve()
    .then(() => revokeAllPublicSharesForSession(sessionId, deletedAt))
    .catch((error) => {
      console.error('[public-shares] revoke on session delete failed', { sessionId, error });
    });

  if (sandbox) {
    const removable =
      !!sandbox.externalId &&
      (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider);
    // One statement, merged in SQL, from the row the UPDATE locks:
    //   - strip every lifecycle fence (restart, wake, recovery, turn
    //     authority), so a detached restart or recovery that is still running
    //     loses its finalize CAS instead of flipping this row back to active;
    //   - record the removal intent. Only a confirmed provider removal clears
    //     it, and reaping/archived-box-removal.ts retries until then.
    const archivePatch: Record<string, unknown> = {
      stoppedAt: deletedAt.toISOString(),
      stopReason: 'manual',
      initStatus: sandbox.status === 'active' ? 'ready' : 'failed',
      ...(sandbox.status === 'active'
        ? {}
        : { lastInitError: 'Session was stopped before sandbox initialization completed' }),
      ...(removable ? { [PROVIDER_REMOVAL_PENDING_KEY]: deletedAt.toISOString() } : {}),
    };
    const archived = await transitionSandbox('archive', sandbox.sandboxId, {
      metadata: { strip: DELETED_SESSION_CLEARED_KEYS, merge: archivePatch },
    }).catch((err) => {
      console.warn(
        `[projects] failed to mark session sandbox archived for ${sessionId}:`,
        err,
      );
      return null;
    });

    if (removable && sandbox.externalId) {
      if (archived) {
        // First attempt now; the maintenance lane retries a failure.
        void attemptArchivedBoxRemoval({
          sandboxId: sandbox.sandboxId,
          externalId: sandbox.externalId,
          provider: sandbox.provider,
          metadata: archivePatch,
        });
      } else {
        // The intent could not be recorded. Keep the old best-effort remove.
        const provider = getProvider(sandbox.provider as SandboxProviderName);
        void provider.remove(sandbox.externalId).catch((err) => {
          console.warn(
            `[projects] failed to remove provider sandbox ${sandbox.externalId} for deleted session ${sessionId}:`,
            err,
          );
        });
      }
    }
  }

  // Keyed by SANDBOX id — `getOpenComputeSession` matches on
  // sandbox_compute_sessions.sandbox_id, so the sessionId this used to pass
  // matched nothing and the delete silently left the meter open, accruing
  // wall-clock on a box we had just asked the provider to remove. The
  // billing-invariant sweep (sandbox-reaper.ts reconcileOrphanComputeSessions)
  // is the backstop for this whole class; this is the fast path.
  if (sandbox) {
    void pauseComputeSession(sandbox.sandboxId).catch((err) =>
      console.warn(
        `[projects] compute pause failed for sandbox ${sandbox.sandboxId}:`,
        err,
      ),
    );
  }

  // The provider sandbox is being removed above, so this session's connector
  // token can never be used legitimately again — but nothing expired it, so it
  // stayed a valid bearer forever. Awaited (not fire-and-forget) so the
  // credential is dead before we report the session gone; a failure is logged at
  // error level rather than failing the delete, since the box is already going.
  await revokeSessionConnectorTokens(sessionId, accountId).catch((err) => {
    console.error(
      `[projects] FAILED to revoke connector tokens for deleted session ${sessionId} — a valid token may outlive its sandbox:`,
      err,
    );
  });

  return { ok: true };
}

export async function restartSession(input: {
  loaded: {
    row: {
      accountId: string;
      projectId: string;
      repoUrl: string;
      defaultBranch: string;
      manifestPath: string;
      metadata?: Record<string, unknown> | null;
    };
    userId: string;
  };
  session: {
    sandboxProvider: string;
    baseRef: string | null;
    agentName: string | null;
    opencodeSessionId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectId: string;
  sessionId: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { loaded, session, projectId, sessionId } = input;
  const providerName = session.sandboxProvider as SandboxProviderName;
  if (
    !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
      providerName,
    )
  ) {
    return {
      status: 400,
      body: { error: `Restart is not supported for provider ${providerName}` },
    };
  }

  const restartUnreachable =
    sandboxCallbackUnreachableReason() ??
    (await sandboxCallbackDeadTunnelReason());
  if (restartUnreachable) {
    return {
      status: 503,
      body: { error: restartUnreachable, code: 'KORTIX_URL_UNREACHABLE' },
    };
  }

  const [existingSandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, sessionId))
    .limit(1);

  const provisionReplacementRuntime = async () => {
    const initialPrompt = session.opencodeSessionId
      ? null
      : typeof session.metadata?.initial_prompt === 'string'
        ? (session.metadata.initial_prompt as string)
        : null;
    const initialTurn = initialPrompt ? prepareInitialSandboxTurn() : null;
    const opencodeModel =
      typeof session.metadata?.opencode_model === 'string'
        ? (session.metadata.opencode_model as string)
        : null;

    await transitionSession('provision', sessionId, { error: null, sandboxUrl: null });

    const runtimeMetadata = { restarted_at: new Date().toISOString() };
    const rehydrate = legacyRehydrateSpec(
      session.metadata,
      loaded.row.metadata,
      loaded.row.projectId,
    );
    allocateSessionRuntime({
      sessionId,
      accountId: loaded.row.accountId,
      projectId,
      userId: loaded.userId,
      project: loaded.row as any,
      providerName,
      baseRef: session.baseRef ?? loaded.row.defaultBranch,
      agentName: session.agentName ?? 'default',
      allowProjectImage: projectImageAllowedForSession(
        session.agentName,
        repositoryAccessFromSessionMetadata(session.metadata),
      ),
      sandboxSlug: sandboxSlugFromSessionMetadata(session.metadata),
      runtimeMetadata,
      initialTurn,
      sessionMetadata: { ...(session.metadata ?? {}), ...runtimeMetadata },
      buildEnvVars: () =>
        buildSessionSandboxEnvVars({
          accountId: loaded.row.accountId,
          projectId,
          sessionId,
          userId: loaded.userId,
          repoUrl: loaded.row.repoUrl,
          baseRef: session.baseRef ?? loaded.row.defaultBranch,
          agentName: session.agentName ?? 'default',
          opencodeModel,
          defaultBranch: loaded.row.defaultBranch,
          manifestPath: loaded.row.manifestPath,
          llmGatewayEnabled: projectLlmGatewayEnabled(loaded.row.metadata),
          // A restarted meta coordinator must keep its meta runtime: without
          // this the rebuilt env loses KORTIX_PROJECT_AUTO_CLONE=0 and the
          // meta agent config, so the daemon clones the project over the meta
          // workspace and wipes /workspace/AGENTS.md.
          platformMetaAgent: isMetaAgentName(session.agentName ?? ''),
          repositoryAccess: repositoryAccessFromSessionMetadata(session.metadata),
          restoreSessionBranch: true,
        }),
      resolveGitProject: async () => withProjectGitAuth(loaded.row as any),
      beforeActive: rehydrate
        ? (externalId) =>
            rehydrateSessionChat({
              sessionId,
              externalId,
              provider: providerName,
              spec: rehydrate,
            })
        : undefined,
    });
  };

  if (
    existingSandbox?.externalId &&
    (config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(
      existingSandbox.provider,
    )
  ) {
    const externalId = existingSandbox.externalId;
    const provider = getProvider(
      existingSandbox.provider as SandboxProviderName,
    );
    const providerStatus = await provider
      .getStatus(externalId)
      .catch(() => 'unknown' as const);
    if (providerStatus === 'removed') {
      const claim = await claimInPlaceRuntimeRecovery(existingSandbox);
      if (!claim) {
        return {
          status: 202,
          body: {
            ok: true,
            session_id: sessionId,
            status: 'provisioning',
            reason: 'runtime_recovery_in_progress',
          },
        };
      }
      const recovery = await provider
        .recoverInPlace?.(externalId)
        .catch(() => 'unavailable' as const);
      if (recovery === 'running' || recovery === 'recovering') {
        const accepted = await markInPlaceRuntimeRecoveryAccepted(
          claim,
          recovery,
        );
        if (!accepted) {
          return {
            status: 409,
            body: {
              error: RUNTIME_IDENTITY_ERROR,
              code: 'SESSION_RUNTIME_RECOVERY_CANCELLED',
              session_id: sessionId,
              external_id: externalId,
              reason: 'runtime_recovery_cancelled',
            },
          };
        }
        return {
          status: 202,
          body: {
            ok: true,
            session_id: sessionId,
            status: 'provisioning',
            reason:
              recovery === 'running'
                ? 'runtime_recovered_in_place'
                : 'runtime_restoring_in_place',
          },
        };
      }
      await preserveEstablishedRuntime(
        claim.row,
        'restart_removed_runtime',
        'restart_failed',
      );
      return {
        status: 409,
        body: {
          error: RUNTIME_IDENTITY_ERROR,
          code: 'SESSION_RUNTIME_IDENTITY_UNAVAILABLE',
          session_id: sessionId,
          external_id: externalId,
          reason: RUNTIME_IDENTITY_UNAVAILABLE,
        },
      };
    }

    const restartStartedAt = new Date();
    const restartId = crypto.randomUUID();
    const restartLeaseExpiresAt = new Date(
      restartStartedAt.getTime() + RUNTIME_RESTART_LEASE_MS,
    );
    const claimedRestart = await claimInPlaceRestart({
      sandboxId: sessionId,
      externalId,
      claim: {
        id: restartId,
        startedAt: restartStartedAt,
        leaseExpiresAt: restartLeaseExpiresAt,
      },
    });
    if (!claimedRestart) {
      const [current] = await db
        .select({ metadata: sessionSandboxes.metadata })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, sessionId))
        .limit(1);
      const metadata = (current?.metadata ?? {}) as Record<string, unknown>;
      return {
        status: 202,
        body: {
          ok: true,
          session_id: sessionId,
          status: 'provisioning',
          reason: restartClaimIsActive(metadata, restartStartedAt)
            ? 'restart_in_progress'
            : 'lifecycle_transition_in_progress',
          operation_id:
            typeof metadata.runtimeRestartId === 'string'
              ? metadata.runtimeRestartId
              : undefined,
        },
      };
    }
    await transitionSession('provision', sessionId, { error: null });

    // Every abandon is logged. A restart that silently lost its claim left the
    // row in `provisioning` with nothing in the logs: SESS-9 sat there ~350 s
    // on every preview because the egress pin overwrote the claim (2026-09).
    const ownsRestart = async (step: string) => {
      const [current] = await db
        .select({ metadata: sessionSandboxes.metadata })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sandboxId, sessionId))
        .limit(1);
      const holder = (current?.metadata as Record<string, unknown> | null)
        ?.runtimeRestartId;
      if (holder === restartId) return true;
      logger.warn('[projects] restart abandoned: lost the restart claim', {
        session_id: sessionId,
        project_id: projectId,
        external_id: externalId,
        restart_id: restartId,
        step,
        row_found: Boolean(current),
        current_restart_id: typeof holder === 'string' ? holder : null,
      });
      return false;
    };

    void (async () => {
      try {
        if (!(await ownsRestart('before_stop'))) return;
        await provider.stop(externalId).catch(() => {});
        if (!(await ownsRestart('after_stop'))) return;
        invalidateProviderCache(externalId);
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeRestartPhase: 'starting' })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sessionSandboxes.sandboxId, sessionId),
              sql`${sessionSandboxes.metadata}->>'runtimeRestartId' = ${restartId}`,
            ),
          );
        await provider.start(externalId, {
          // A restore from cold storage runs inside start() and can outlast
          // the restart lease; keep it, fenced to this restart.
          onProgress: async () => {
            const leaseExpiresAt = new Date(Date.now() + RUNTIME_RESTART_LEASE_MS);
            await db
              .update(sessionSandboxes)
              .set({
                metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({ runtimeRestartLeaseExpiresAt: leaseExpiresAt.toISOString() })}::jsonb`,
              })
              .where(
                and(
                  eq(sessionSandboxes.sandboxId, sessionId),
                  sql`${sessionSandboxes.metadata}->>'runtimeRestartId' = ${restartId}`,
                ),
              );
          },
        });
        if (!(await ownsRestart('after_start'))) return;
        // Provider ingress credentials can change on every stop/start cycle.
        // Remove any link resolved while the sandbox was stopped.
        invalidateProviderCache(externalId);
        // A provider may acknowledge start before discovering that the backing
        // runtime is gone. A confirmed `removed` status starts recovery.
        // `unknown` remains non-terminal because it does not prove runtime loss.
        let verifiedStatus = await provider
          .getStatus(externalId)
          .catch(() => 'unknown' as const);
        if (
          verifiedStatus === 'unknown' &&
          (await inspectSandboxRuntime(externalId, loaded.userId))
        ) {
          verifiedStatus = 'running';
        }
        for (
          let attempt = 1;
          verifiedStatus !== 'running' &&
          verifiedStatus !== 'removed' &&
          attempt < 15;
          attempt += 1
        ) {
          await Bun.sleep(1_000);
          verifiedStatus = await provider
            .getStatus(externalId)
            .catch(() => 'unknown' as const);
          if (
            verifiedStatus === 'unknown' &&
            (await inspectSandboxRuntime(externalId, loaded.userId))
          ) {
            verifiedStatus = 'running';
          }
        }
        if (verifiedStatus === 'removed') {
          if (!(await ownsRestart('before_recovery'))) return;
          const claim = await claimInPlaceRuntimeRecovery(existingSandbox);
          if (!claim) return;
          const recovery = await provider
            .recoverInPlace?.(externalId)
            .catch(() => 'unavailable' as const);
          if (recovery === 'running' || recovery === 'recovering') {
            await markInPlaceRuntimeRecoveryAccepted(claim, recovery).catch(
              () => null,
            );
          } else {
            await preserveEstablishedRuntime(
              claim.row,
              'restart_post_start_removed',
              'restart_failed',
            ).catch(() => null);
          }
          return;
        }
        if (verifiedStatus !== 'running' && verifiedStatus !== 'unknown') {
          throw new Error(
            `Sandbox ${externalId} did not reach running after restart (provider status: ${verifiedStatus})`,
          );
        }
        if (verifiedStatus === 'unknown') {
          logger.warn(
            '[projects] restart provider status stayed unknown; runtime polling continues',
            {
              session_id: sessionId,
              project_id: projectId,
              external_id: externalId,
            },
          );
        }
        // A session deleted during the restart stays deleted: its row is
        // archived, and `activate` never leaves `archived`.
        const finalized = await transitionSandbox('activate', sessionId, {
          metadata: { strip: RESTART_CLAIM_KEYS },
          guard: sql`${sessionSandboxes.metadata}->>'runtimeRestartId' = ${restartId}`,
        });
        if (!finalized) {
          logger.warn('[projects] restart abandoned: lost the restart claim', {
            session_id: sessionId,
            project_id: projectId,
            external_id: externalId,
            restart_id: restartId,
            step: 'finalize',
          });
          return;
        }
        await transitionSession('resume', sessionId);
        // A restart is a stop/start of the SAME box: the provider hands back the
        // env it was created with, so this used to cost a full boot and return
        // byte-identical stale config. People restarted precisely to pick up a
        // merged agent change and got the old agents back, which is most of why
        // "there is no way to reload" felt true.
        //
        // Converge on the session's base ref. Best-effort and after the
        // session is already marked running: a box that is up with old config
        // beats one parked because a git read failed.
        //
        // This used to push the compiled config alone. That moved the etag and
        // left the agent unchanged, because opencode reads the agent `.md` files
        // from the working tree and a restart never touched them. The
        // convergence syncs those files first, and skips the second opencode
        // restart entirely when the box is already current.
        //
        // A restart resumes the SAME VM, so the daemon's boot-time reconcile
        // never re-runs and the box keeps whatever `kortix` binary its image was
        // built with — the exact reason production sandboxes ran a CLI that
        // predated the routes it calls. Poke the daemon to re-converge. Detached
        // and after the session is already marked running: this must not extend
        // the restart the user is waiting on.
        //
        // AWAITED here, not fire-and-forget (`scheduleSandboxRuntimeRefresh`'s
        // usual form) — still inside this already-detached block, so the 202
        // sent long ago is unaffected. `POST /kortix/refresh?restart=0` is what
        // now also fetches the live managed-model lineup and rewrites the
        // overlay file (see `convergeManagedModelCatalog`, `allowRestart:
        // false`), and config convergence right below is what actually
        // RESPAWNS opencode. Racing the two left a real dev box restarting
        // straight back onto its stale managed lineup 2026-09-26: the config
        // convergence's respawn read whatever catalog file was on disk at THAT
        // instant, and the runtime-asset refresh's write had not landed yet.
        // Awaiting closes that race — the file is current before anything
        // that reads it from disk gets a chance to spawn.
        await refreshSandboxRuntimeAssets(sessionId).catch(() => 'unreachable' as const);
        scheduleSessionConfigConvergence(sessionId, 'restart');
      } catch (err) {
        // Detached from the request (the 202 already went out) — a structured
        // error is the only trace the reboot died and the session was parked.
        logger.error(
          '[projects] restart-in-place failed — session parked stopped',
          {
            session_id: sessionId,
            project_id: projectId,
            external_id: externalId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        if (isMissingRuntimeError(err)) {
          const claim = await claimInPlaceRuntimeRecovery(existingSandbox);
          if (!claim) return;
          const recovery = await provider
            .recoverInPlace?.(externalId)
            .catch(() => 'unavailable' as const);
          if (recovery === 'running' || recovery === 'recovering') {
            await markInPlaceRuntimeRecoveryAccepted(claim, recovery).catch(
              () => null,
            );
          } else {
            // Incident 2026-08-14: a loss verdict requires a fresh, definitive
            // provider `removed` — nothing else may reach the terminal "computer
            // was lost" state. Neither condition that got us here is evidence of
            // one. `isMissingRuntimeError` is a message heuristic that matches
            // any error whose text merely contains "not found", and
            // `recoverInPlace` is OPTIONAL: `?.` yields `undefined` for a
            // provider that does not implement it, which is indistinguishable
            // here from a provider that tried and failed. The sibling restart
            // paths above both gate on `getStatus() === 'removed'` before they
            // preserve; this one is reached from a catch block and did not, so
            // an unrelated "not found" thrown mid-restart reported a live box as
            // lost — unrecoverable and non-retriable to the user, a false
            // `runtime.lost` page, and the box left running because only a park
            // stops it. Ask the provider, then let the shared gate decide.
            const status = await (async () => {
              try {
                return await provider.getStatus(externalId);
              } catch {
                return 'unknown' as const;
              }
            })();
            if (runtimeLossVerdict(status) === 'preserve') {
              await preserveEstablishedRuntime(
                claim.row,
                'restart_missing_runtime',
                'restart_failed',
              ).catch(() => null);
            } else {
              await parkEstablishedRuntime(
                claim.row,
                'restart_missing_runtime',
                'restart_failed',
              ).catch(() => null);
            }
          }
          return;
        }
        const failedRestart = await transitionSandbox('stop', sessionId, {
          metadata: {
            strip: RESTART_CLAIM_KEYS,
            merge: {
              runtimeRestartFailedAt: new Date().toISOString(),
              runtimeRestartError: err instanceof Error ? err.message : String(err),
            },
          },
          guard: and(
            eq(sessionSandboxes.externalId, externalId),
            sql`${sessionSandboxes.metadata}->>'runtimeRestartId' = ${restartId}`,
          ),
        }).catch(() => null);
        if (!failedRestart) return;
        await transitionSession('park', sessionId).catch(() => false);
      }
    })();

    return {
      status: 202,
      body: {
        ok: true,
        session_id: sessionId,
        status: 'provisioning',
        reason: 'restart_started',
        operation_id: restartId,
      },
    };
  }

  if (existingSandbox) {
    // Row exists but never reached a real provider sandbox (e.g. the original
    // provision failed before an externalId was assigned) — there's nothing to
    // stop/start, and leaving it in place would collide with the fresh insert
    // provisionReplacementRuntime() is about to do on the same sandboxId PK.
    await retireUnmaterializedRuntime(
      existingSandbox,
      'restart_never_provisioned',
    ).catch((err) =>
      console.warn(
        `[projects] failed to retire never-provisioned sandbox row for session ${sessionId}:`,
        err,
      ),
    );
  }

  await provisionReplacementRuntime();
  return {
    status: 202,
    body: { ok: true, session_id: sessionId, status: 'provisioning' },
  };
}
