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
  ensureSandboxImage,
  deleteSandboxImage,
  resolveTemplate,
  DEFAULT_SANDBOX_SLUG,
  type EnsureSandboxImageResult,
} from '../../snapshots/builder';
import { config } from '../../config';
import { ProvisionTimeline } from './provision-timeline';
import type { GitBackedProject } from '../../projects/git';
import { startComputeSession } from '../../billing/services/compute-metering';
import { resolveYoloTokenForMember } from '../../billing/services/yolo-tokens';
import { getCreditAccount } from '../../billing/repositories/credit-accounts';
import { isPerSeatAccount } from '../../billing/services/tiers';
import { readManifest } from '../../projects/triggers';

// Fallback spec for sandboxes that don't declare [sandbox] in kortix.toml.
// Mirrors a sensible Daytona default (1 vCPU / 2 GB / 10 GB).
const DEFAULT_METERING_SPEC = { cpuCores: 1, memoryGb: 2, diskGb: 10, gpuCount: 0 };

async function openComputeSessionForSandbox(
  sandboxId: string,
  accountId: string,
  project: GitBackedProject,
  userId: string | null | undefined,
  sandboxSlug: string | undefined,
): Promise<void> {
  let spec = { ...DEFAULT_METERING_SPEC };
  try {
    const tpl = await resolveTemplate(project, sandboxSlug);
    if (tpl.cpu !== undefined) spec.cpuCores = tpl.cpu;
    if (tpl.memoryGb !== undefined) spec.memoryGb = tpl.memoryGb;
    if (tpl.diskGb !== undefined) spec.diskGb = tpl.diskGb;
  } catch {
    // Template resolution failed (repo unreachable, parse error, etc.). Fall
    // back to defaults so metering still records the session.
  }
  await startComputeSession({
    sandboxId,
    accountId,
    sessionId: sandboxId,
    actorUserId: userId ?? null,
    spec,
  });
}

export interface ProvisionSessionSandboxResult {
  row: typeof sessionSandboxes.$inferSelect;
  created: boolean;
}

/**
 * Daytona occasionally drops an image between when we resolved it and when we
 * tried to boot from it — `snapshot.get` says active, then `sandbox.create`
 * says missing. Detect that one specific race so we can rebuild and retry once.
 */
function isSnapshotMissingOnProvider(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes('snapshot')) return false;
  return message.includes('not found') || message.includes('does not exist');
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
   * Project + ref the session boots against. The boot path resolves the
   * commit SHA for `baseRef` and asks the snapshot builder for the matching
   * Daytona image — building inline if it doesn't exist yet. When `baseRef`
   * is omitted, defaults to `gitProject.defaultBranch`.
   */
  gitProject: GitBackedProject;
  resolveGitAuthToken?: () => Promise<string | null>;
  /**
   * Warm-pool lifecycle state for the inserted row. Pass 'booting' to provision
   * a pre-booted pool sandbox (no project_sessions row); leave undefined for a
   * normal session sandbox. See docs/specs/warm-pool.md.
   */
  poolState?: string;
  baseRef?: string;
  /**
   * Slug of the sandbox template to boot from. Resolves against the project's
   * `[[sandbox.templates]]` entries. Empty/undefined → platform default.
   */
  sandboxSlug?: string;
  /**
   * Runs after the provider sandbox is created but BEFORE the row is flipped to
   * `active`. Used by legacy migration to restore the original opencode store
   * into the sandbox before the frontend's `ensure-opencode` pin runs (which
   * would otherwise re-pin to a fresh session). Best-effort: a throw is logged
   * and provisioning still completes to `active`.
   */
  beforeActive?: (externalId: string) => Promise<void>;
}): Promise<ProvisionSessionSandboxResult> {
  const { sandboxId, accountId, projectId, userId, serverType, location } = opts;
  // Resolution order:
  //   1. Explicit per-request `opts.provider` (set by callers that need a
  //      specific runtime, e.g. when restarting an existing sandbox).
  //   2. `config.getDefaultProvider()` — head of ALLOWED_SANDBOX_PROVIDERS.
  const providerName = opts.provider || config.getDefaultProvider();
  const provider = getProvider(providerName);
  const tl = new ProvisionTimeline(sandboxId, 'provision');

  const slug = (opts.sandboxSlug ?? '').trim() || DEFAULT_SANDBOX_SLUG;
  // Resolve the project + a fresh git auth token (the snapshot builder may need
  // it to read the repo's Dockerfile when building a custom template).
  const resolveGitProject = async (): Promise<GitBackedProject> => {
    if (!opts.resolveGitAuthToken) return opts.gitProject;
    const token = await opts.resolveGitAuthToken();
    return { ...opts.gitProject, gitAuthToken: token };
  };

  // Kick image resolution off NOW, in parallel with the token round-trip below.
  // The snapshot identity + provider cache-check depend only on the repo
  // contents — never on the freshly-minted session tokens — so there is no
  // reason to wait for the tokens before asking the provider whether the image
  // already exists. On the warm path this overlaps the ~200ms token round-trip
  // with the ~100-300ms cache-check, taking the smaller off the critical path.
  type FirstImage = EnsureSandboxImageResult & { gitProject: GitBackedProject };
  let firstImagePromise: Promise<FirstImage> | null = (async () => {
    const gitProject = await resolveGitProject();
    const image = await ensureSandboxImage(gitProject, {
      slug,
      accountId,
      source: 'session-start',
    });
    return { ...image, gitProject };
  })();
  // Swallow the unhandled-rejection warning; the IIFE's try/catch owns the error
  // when it awaits the promise.
  firstImagePromise.catch(() => {});

  // Sandbox-row insert + tokens + credit lookup all run in parallel. None of
  // them depend on the others — `sandboxId` is known up front, so even the
  // sandbox API key can be minted before the row lands. Previously serial
  // (~100ms each on a warm DB), now ~one round-trip total.
  const sandboxName = `session-${sandboxId.slice(0, 8)}`;
  const [sandboxRows, sandboxKey, executorToken, llmApiKey] = await Promise.all([
    db
      .insert(sessionSandboxes)
      .values({
        sandboxId,
        sessionId: sandboxId,
        accountId,
        projectId,
        provider: providerName,
        externalId: null,
        status: 'provisioning',
        poolState: opts.poolState ?? null,
        baseUrl: null,
        config: {},
        metadata: {
          ...(opts.metadata ?? {}),
          initStatus: 'pending',
          initAttempts: 0,
          initMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
          healthStatus: 'unknown',
        },
      })
      .returning(),
    createApiKey({
      sandboxId,
      accountId,
      title: 'Sandbox Token',
      type: 'sandbox',
    }),
    createAccountToken({
      accountId,
      userId,
      projectId,
      name: `Executor Session ${sandboxId.slice(0, 8)}`,
    })
      .then((tok) => tok.secretKey)
      .catch((err) => {
        console.warn(`[session-sandbox] failed to mint executor token for ${projectId}:`, err);
        return null as string | null;
      }),
    getCreditAccount(accountId)
      .then(async (account) => {
        const hasActiveSub =
          !!account?.stripeSubscriptionId &&
          account.stripeSubscriptionStatus !== 'canceled' &&
          account.stripeSubscriptionStatus !== 'unpaid';
        if (isPerSeatAccount(account?.billingModel) && hasActiveSub && userId) {
          return resolveYoloTokenForMember(userId, accountId);
        }
        return null as string | null;
      })
      .catch((err) => {
        console.warn(
          `[session-sandbox] failed to resolve LLM gateway token for ${userId}@${accountId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return null as string | null;
      }),
  ]);
  const [sandbox] = sandboxRows;
  tl.mark('row+tokens');

  const llmBaseUrl = `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/llm`;

  const providerCreateInput: CreateSandboxOpts = {
    accountId,
    userId,
    name: sandboxName,
    serverType,
    location,
    envVars: {
      ...(opts.extraEnvVars ?? {}),
      KORTIX_TOKEN: sandboxKey.secretKey,
      // The project-scoped PAT does double duty: it backs the executor MCP
      // gateway AND the in-sandbox `kortix` CLI. KORTIX_TOKEN (the sandbox
      // service key) is rejected by the project-scoped routes the CLI hits
      // (change-requests, secrets, …) — only this account token authenticates
      // there. Inject it under KORTIX_CLI_TOKEN so `kortix …` is pre-authed
      // with zero setup; see apps/cli/src/api/config.ts (activeHost()).
      ...(executorToken
        ? { KORTIX_EXECUTOR_TOKEN: executorToken, KORTIX_CLI_TOKEN: executorToken }
        : {}),
      ...(llmApiKey
        ? {
            KORTIX_LLM_API_KEY: llmApiKey,
            KORTIX_LLM_BASE_URL: llmBaseUrl,
            KORTIX_YOLO_API_KEY: llmApiKey,
            KORTIX_YOLO_URL: llmBaseUrl,
          }
        : {}),
    },
    // Warm-pool boxes disable provider auto-stop so they stay ready until
    // claimed; once claimed (pool_state cleared) our idle sweep hibernates them.
    ...(opts.poolState ? { autoStopInterval: 0 } : {}),
  };

  // Detach the actual provisioning — the API caller navigates immediately
  // and the dashboard's ConnectingScreen handles the long tail.
  void (async () => {
    let bgExternalId: string | null = null;
    // Single retry hook: if Daytona's sandbox.create races a snapshot deletion
    // and reports "not found", we rebuild and retry once. More than once means
    // something is genuinely broken — surface the error.
    let healedStaleSnapshot = false;
    let imageInfo: { snapshotName: string; slug: string; contentHash: string; isDefault: boolean } | null = null;
    provisioning: while (true) {
    try {
      const branch = opts.baseRef || opts.gitProject.defaultBranch;

      // Stateless image resolution: ask Daytona if it has the image; build if not.
      // No DB lookup, no degraded fallback — the snapshot is either there or we
      // build it inline. The build log captures the attempt for the dashboard;
      // it is never read on this path. The first attempt consumes the promise we
      // kicked off in parallel with the token round-trip; heal-retries re-resolve
      // from scratch (the prior snapshot was just deleted).
      let image: EnsureSandboxImageResult;
      if (firstImagePromise) {
        image = await firstImagePromise;
        firstImagePromise = null;
      } else {
        const gitProject = await resolveGitProject();
        image = await ensureSandboxImage(gitProject, {
          slug,
          accountId,
          source: 'session-start',
        });
      }
      imageInfo = {
        snapshotName: image.snapshotName,
        slug: image.slug,
        contentHash: image.contentHash,
        isDefault: image.isDefault,
      };
      tl.mark(image.built ? 'image-built' : 'image-cached');
      providerCreateInput.snapshot = image.snapshotName;
      console.log(
        `[session-sandbox] Booting ${sandbox.sandboxId} from ${image.snapshotName} ` +
        `(template "${image.slug}"${image.isDefault ? ' [platform default]' : ''}, ` +
        `branch ${branch}, ${image.built ? 'fresh build' : 'cache hit'})`,
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
        tl.log({ provider: providerName, attempts, stoppedBeforeActive: true });
        return;
      }

      // Pre-active hook (legacy migration chat restore). Runs while the row is
      // still 'provisioning' so the frontend hasn't started ensure-opencode yet.
      // Best-effort: never block the session opening on it.
      if (opts.beforeActive) {
        try {
          await opts.beforeActive(result.externalId);
          tl.mark('before-active-hook');
        } catch (err) {
          console.warn(`[session-sandbox] beforeActive hook failed for ${sandbox.sandboxId}:`, err);
        }
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
              artifactType: providerName === 'daytona' ? 'daytona_snapshot' : 'unknown',
              providerArtifactRef: imageInfo!.snapshotName,
              contentHash: imageInfo!.contentHash,
              sandboxSlug: imageInfo!.slug,
              isPlatformDefault: imageInfo!.isDefault,
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

      tl.mark('row-active');
      tl.log({ provider: providerName, attempts });

      // Billing v2 — open a compute metering row. No-op for legacy accounts.
      // Spec is resolved from the project manifest with provider-default fallbacks.
      void openComputeSessionForSandbox(sandbox.sandboxId, accountId, opts.gitProject, userId, imageInfo?.slug).catch(
        (err) =>
          console.warn(
            `[session-sandbox] failed to open compute metering for ${sandbox.sandboxId}:`,
            err instanceof Error ? err.message : String(err),
          ),
      );
      break provisioning;
    } catch (bgErr) {
      // Daytona dropped the image between resolve and create. Force a rebuild
      // (delete the snapshot so the next ensureSandboxImage call rebuilds it)
      // and retry once. Capped at one heal per session start.
      if (isSnapshotMissingOnProvider(bgErr) && imageInfo && !healedStaleSnapshot) {
        healedStaleSnapshot = true;
        await deleteSandboxImage(opts.gitProject, { slug: imageInfo.slug }).catch((err) =>
          console.warn(
            `[session-sandbox] force-rebuild failed for ${imageInfo!.snapshotName}:`,
            err,
          ),
        );
        console.warn(
          `[session-sandbox] healing missing image ${imageInfo.snapshotName} for ${sandbox.sandboxId} — retrying`,
        );
        if (bgExternalId) {
          await provider.remove(bgExternalId).catch((cleanupErr) =>
            console.warn(`[session-sandbox] post-heal cleanup of ${bgExternalId} failed:`, cleanupErr),
          );
          bgExternalId = null;
        }
        imageInfo = null;
        continue provisioning;
      }

      const bgMessage = bgErr instanceof Error ? bgErr.message : String(bgErr);
      // Provider-capacity errors (Daytona "No available runners", rate limits)
      // are transient outages, not session failures. Log them as a warning so
      // they don't read as code bugs in the console, and present a friendly
      // message to the user instead of the SDK stack trace.
      const isCapacity = /no available runner|no runners available|out of capacity|capacity exceeded|rate ?limit|too many requests/i.test(bgMessage);
      const userMessage = isCapacity
        ? 'The sandbox provider is at capacity right now. Try again in a minute.'
        : `Provisioning failed via ${providerName}.`;
      if (isCapacity) {
        console.warn(
          `[session-sandbox] provider at capacity for ${sandbox.sandboxId} after retries — bouncing session:`,
          bgMessage.slice(0, 200),
        );
      } else {
        console.error(`[session-sandbox] Background provisioning failed for ${sandbox.sandboxId}:`, bgErr);
      }

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
              errorMessage: userMessage,
              lastProvisioningError: bgMessage.slice(0, 500),
              ...(isCapacity ? { failureCategory: 'provider-capacity' as const } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        await db
          .update(projectSessions)
          .set({ status: 'failed', error: userMessage, updatedAt: new Date() })
          .where(eq(projectSessions.sessionId, sandbox.sandboxId))
          .catch(() => {});
      } catch (markErr) {
        console.error(`[session-sandbox] Failed to mark sandbox ${sandbox.sandboxId} as error:`, markErr);
      }
      break provisioning;
    }
    }
  })();

  return { row: sandbox, created: true };
}
