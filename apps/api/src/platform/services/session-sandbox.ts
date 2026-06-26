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
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { createApiKey } from '../../repositories/api-keys';
import { createAccountToken } from '../../repositories/account-tokens';
import {
  getProvider,
  WarmRuntimeUnavailableError,
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
import { ensureWarmBaseReady, warmPathPaused } from '../../snapshots/warm-bake';
import { config } from '../../config';
import { providerFallbackSetting } from './runtime-settings';
import { selectProvider } from './provider-balancer';
import { ProvisionTimeline } from './provision-timeline';
import { recordProviderEvent } from './provider-events';
import type { GitBackedProject } from '../../projects/git';
import { startComputeSession } from '../../billing/services/compute-metering';
import { readManifest } from '../../projects/triggers';
import { resolveAgentGrant } from '../../projects/agents';

// Fallback spec for sandboxes that don't declare [sandbox] in kortix.toml.
// Mirrors the platform default sandbox size (2 vCPU / 6 GB / 20 GB).
const DEFAULT_METERING_SPEC = { cpuCores: 2, memoryGb: 6, diskGb: 20, gpuCount: 0 };

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

/**
 * Resolve the agent's grant from the manifest's `[[agents]]` overlay, then mint
 * the per-session executor/CLI account token carrying it. Best-effort: a manifest
 * hiccup yields a null grant (full access, capped at the user by the route's own
 * role check) and a mint failure yields null — neither bricks a session. The
 * grant is read from the default branch, so any `[[agents]]` change activates
 * only via a merged CR.
 */
async function mintExecutorToken(opts: {
  accountId: string;
  userId: string;
  projectId: string;
  sandboxId: string;
  agentName: string;
  gitProject: GitBackedProject;
}): Promise<string | null> {
  const agentGrant = await resolveAgentGrant(opts.agentName, opts.gitProject).catch((err) => {
    console.warn(`[session-sandbox] failed to resolve agent grant for ${opts.projectId}:`, err);
    return null;
  });
  try {
    const tok = await createAccountToken({
      accountId: opts.accountId,
      userId: opts.userId,
      projectId: opts.projectId,
      // session_id == sandbox_id by construction — lets the LLM gateway attribute
      // usage_events to this session (the reaper's reliable activity signal).
      sessionId: opts.sandboxId,
      name: `Executor Session ${opts.sandboxId.slice(0, 8)}`,
      agentGrant,
    });
    return tok.secretKey;
  } catch (err) {
    console.warn(`[session-sandbox] failed to mint executor token for ${opts.projectId}:`, err);
    return null;
  }
}

export async function provisionSessionSandbox(opts: {
  sandboxId: string;
  accountId: string;
  projectId: string;
  userId: string;
  /** The selected agent's name (= projectSessions.agentName). Resolves the
   *  per-agent grant stamped onto the session's account token. Defaults to
   *  'default' when omitted (legacy callers). */
  agentName?: string;
  provider?: ProviderName;
  serverType?: string;
  location?: string;
  metadata?: Record<string, unknown>;
  /** Project metadata, used for per-project experimental gates. */
  projectMetadata?: unknown;
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
  baseRef?: string;
  /**
   * Slug of the sandbox template to boot from. Resolves against the project's
   * `[[sandbox.templates]]` entries. Empty/undefined → platform default.
   */
  sandboxSlug?: string;
  /**
   * The project's per-project warm snapshot (projects.metadata.warm_snapshot
   * .name — repo baked at tip + warm opencode caches). Preferred over the
   * generic warm base when usable; verified against the provider before use,
   * so a stale pointer just falls back. See snapshots/warm-project.ts.
   */
  projectWarmSnapshot?: { name: string; provider: ProviderName } | null;
  /**
   * Runs after the provider sandbox is created but BEFORE the row is flipped to
   * `active`. Used by legacy migration to restore the original opencode store
   * into the sandbox before the frontend's `ensure-opencode` pin runs (which
   * would otherwise re-pin to a fresh session). Best-effort: a throw is logged
   * and provisioning still completes to `active`.
   */
  beforeActive?: (externalId: string) => Promise<void>;
  /**
   * Set when this box is a warm-pool spare (its sessionSandboxes.poolState).
   * Such boxes opt OUT of provider auto-stop so they stay warm until claimed;
   * normal session sandboxes leave it undefined and auto-stop on idle. (Warm
   * pool is disabled by default — see warm-pool.ts / KORTIX_WARM_POOL_SIZE.)
   */
  poolState?: string | null;
}): Promise<ProvisionSessionSandboxResult> {
  const { sandboxId, accountId, projectId, userId, serverType, location } = opts;
  // Resolution order:
  //   1. Explicit per-request `opts.provider` (set by callers that need a
  //      specific runtime, e.g. when restarting an existing sandbox).
  //   2. `config.getDefaultProvider()` — head of ALLOWED_SANDBOX_PROVIDERS.
  // `let`, not `const`: provider failover (one-shot, admin-gated) reassigns
  // these in the provision loop's catch when the primary fails at birth.
  let providerName = opts.provider || (await selectProvider());
  let provider = getProvider(providerName);
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
  // Experimental warm path. Preference order:
  //   1. The PROJECT's warm snapshot (repo already cloned at tip + opencode
  //      caches warm — skips the clone entirely; commits since bake are
  //      fast-forwarded post-boot via /kortix/refresh).
  //   2. The generic warm runtime base (skips the cold create; clone still runs).
  //   3. null → the normal Dockerfile-snapshot path.
  // Master gate is the warm_snapshot admin toggle (default ON); daytona also
  // needs DAYTONA_WARM_TARGET, platinum a configured host (warmSnapshotsEnabledFor).
  // Restricted to the platform-default slug: warm snapshots carry only the
  // default runtime, so a project with a custom [[sandbox.templates]] Dockerfile
  // must still boot its own per-project image.
  let warmBase: string | null = null;
  let warmIsProjectSnapshot = false;
  // Skip ALL warm routes while the warm path is in post-failure cooldown — a
  // degraded warm region (experimental "internal error" streaks) must not make
  // every session pay a doomed warm attempt before falling back to cold. The
  // generic base path already honors this; the per-project branch must too.
  if (slug === DEFAULT_SANDBOX_SLUG && !warmPathPaused()) {
    const ptr = opts.projectWarmSnapshot;
    // Only consume a pointer baked for THIS session's provider (the pointer
    // carries its provider; a daytona artifact can't be forked on platinum).
    if (ptr && ptr.provider === providerName) {
      try {
        const { warmSnapshotsEnabledFor } = await import('../../shared/daytona');
        if (warmSnapshotsEnabledFor(providerName)) {
          if (providerName === 'platinum') {
            // Platinum's per-project warm snapshot is a STATEFUL template; if it's
            // ready on the host it CoW-forks on a normal create (no warm-base
            // field). A pure provider state check — no extra round-trip class.
            const { platinumProvider } = await import('../../snapshots/providers/platinum');
            if ((await platinumProvider.getSnapshotState(ptr.name)) === 'active') {
              warmBase = ptr.name;
              warmIsProjectSnapshot = true;
            }
          } else if (providerName === 'daytona') {
            // Cached + bounded + region-keyed (warmSnapshotUsableCached): a warm hit
            // is a pure in-process check, and a degraded region times out in 4s AND
            // pauses the warm path — so the generic-base lookup below short-circuits
            // instead of paying a SECOND serial probe on the request-blocking path.
            const { warmSnapshotUsableCached } = await import('../../snapshots/warm-bake');
            if (await warmSnapshotUsableCached(ptr.name)) {
              warmBase = ptr.name;
              warmIsProjectSnapshot = true;
            }
          }
        }
      } catch {
        // pointer is stale / lookup slow → fall through to cold (or generic base)
      }
    }
    // The generic memory-state warm base is Daytona-only (Platinum has no
    // equivalent; it cold-spawns when there's no per-project warm template).
    if (!warmBase && providerName === 'daytona') warmBase = await ensureWarmBaseReady();
  }
  let firstImagePromise: Promise<FirstImage> | null = warmBase
    ? null
    : (async () => {
        const gitProject = await resolveGitProject();
        const image = await ensureSandboxImage(gitProject, {
          slug,
          accountId,
          source: 'session-start',
          provider: providerName,
        });
        return { ...image, gitProject };
      })();
  // Swallow the unhandled-rejection warning; the IIFE's try/catch owns the error
  // when it awaits the promise.
  firstImagePromise?.catch(() => {});

  // Sandbox-row insert + tokens + credit lookup all run in parallel. None of
  // them depend on the others — `sandboxId` is known up front, so even the
  // sandbox API key can be minted before the row lands. Previously serial
  // (~100ms each on a warm DB), now ~one round-trip total.
  const sandboxName = `session-${sandboxId.slice(0, 8)}`;
  const [sandboxRows, sandboxKey, executorToken] = await Promise.all([
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
    // Resolve the per-agent grant from kortix.toml's [[agents]] overlay and mint
    // the executor/CLI account token carrying it (best-effort — see helper).
    mintExecutorToken({
      accountId,
      userId,
      projectId,
      sandboxId,
      agentName: opts.agentName ?? 'default',
      gitProject: opts.gitProject,
    }),
  ]);
  const [sandbox] = sandboxRows;
  tl.mark('row+tokens');

  const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
  const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  const llmBaseUrl =
    config.LLM_GATEWAY_BASE_URL ||
    (llmProxyMode ? `${kortixOrigin}/v1/llm-gateway/v1/llm` : `${kortixOrigin}/v1/llm`);

  // The sandbox's OpenCode `kortix` provider mounts when KORTIX_LLM_* is
  // injected. It authenticates the gateway with the per-session executor PAT,
  // which the gateway resolves via validateAccountToken and meters.
  //
  // The gateway is the ONLY LLM path: always inject KORTIX_LLM_* whenever we have
  // an executor token. Tier/affordability is enforced per-request INSIDE the
  // gateway (resolve-candidates tier gate + billing gate), not as a provisioning
  // gate — so a non-entitled account still reaches the gateway and gets a clear
  // per-request 402/“model not available” rather than being silently stripped.
  const gatewayLlmKey: string | null = executorToken;

  const providerCreateInput: CreateSandboxOpts = {
    accountId,
    userId,
    name: sandboxName,
    serverType,
    location,
    envVars: {
      ...(opts.extraEnvVars ?? {}),
      // ── Sandbox token model — TWO credentials, two principals ──────────────
      // 1) The SANDBOX credential (`kortix_sb_…`): the daemon's identity. It is
      //    the HMAC key the API signs `X-Kortix-User-Context` with (the daemon
      //    verifies it) AND the bearer for the 3 sandbox-identity routes
      //    (/git/clone-credential, /turn-stream, /turn-question). It carries NO
      //    user identity, so project-scoped routes reject it. Injected under the
      //    self-documenting `KORTIX_SANDBOX_TOKEN`; `KORTIX_TOKEN` is kept as a
      //    back-compat alias for daemons baked before the rename.
      // 2) The SESSION credential (`kortix_pat_…`, `executorToken`): acts AS the
      //    launching user, scoped by the agent grant. It backs the Executor
      //    gateway AND the in-sandbox `kortix` CLI. Injected under
      //    `KORTIX_CLI_TOKEN` (+ `KORTIX_EXECUTOR_TOKEN` alias for the executor).
      // The agent never needs the sandbox credential — see apps/cli config.ts
      // (activeHost() resolves only the session token).
      // Phase 2 (after baked images cycle): drop the `KORTIX_TOKEN` /
      // `KORTIX_EXECUTOR_TOKEN` aliases and let `KORTIX_TOKEN` MEAN the session
      // token, so the agent world has exactly one obvious var.
      KORTIX_SANDBOX_TOKEN: sandboxKey.secretKey,
      KORTIX_TOKEN: sandboxKey.secretKey,
      ...(executorToken
        ? { KORTIX_CLI_TOKEN: executorToken, KORTIX_EXECUTOR_TOKEN: executorToken }
        : {}),
      ...(gatewayLlmKey
        ? {
            KORTIX_LLM_API_KEY: gatewayLlmKey,
            KORTIX_LLM_BASE_URL: llmBaseUrl,
            KORTIX_YOLO_API_KEY: gatewayLlmKey,
            KORTIX_YOLO_URL: llmBaseUrl,
          }
        : {}),
    },
    // Idle lifecycle: each provider's NATIVE auto-stop is the primary stop
    // mechanism. We pass NO explicit autoStopInterval for a normal session so the
    // provider applies its own policy: Daytona → daytonaLifecycle()
    // (KORTIX_SANDBOX_AUTOSTOP_MINUTES); Platinum → the same idle timeout (see
    // platinum.ts). Platinum NO LONGER forces persistent — the CH resume-freeze
    // that required autoStop=0 is FIXED (verified ~2.3s stop→resume), so it
    // idle-stops + CoW-resumes natively rather than depending on the maintenance
    // reaper (whose outage let Platinum boxes run 24/7 and flood the host). The
    // reaper stays as a secondary backstop only. Warm seeds / legacy spares pass
    // an EXPLICIT autoStopInterval=0 to stay persistent.
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
    // Provider failover (one-shot, on init): set true once we've handed off to a
    // second provider, so a session never bounces between providers forever.
    let fallbackAttempted = false;
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
      if (warmBase) {
        // Warm path: no per-project Dockerfile snapshot — boot the shared
        // memory-state warm base; the provider starts the daemon post-restore.
        image = { snapshotName: warmBase, slug, contentHash: 'warm', built: false, isDefault: true };
      } else if (firstImagePromise) {
        image = await firstImagePromise;
        firstImagePromise = null;
      } else {
        const gitProject = await resolveGitProject();
        image = await ensureSandboxImage(gitProject, {
          slug,
          accountId,
          source: 'session-start',
          provider: providerName,
        });
      }
      imageInfo = {
        snapshotName: image.snapshotName,
        slug: image.slug,
        contentHash: image.contentHash,
        isDefault: image.isDefault,
      };
      tl.mark(warmBase ? 'warm-base' : image.built ? 'image-built' : 'image-cached');
      if (warmBase) {
        // Platinum: the warm artifact is a stateful TEMPLATE — boot it normally
        // and the host CoW-forks it. Daytona: it's a memory snapshot restored via
        // the dedicated warmBaseSnapshot field.
        if (providerName === 'platinum') providerCreateInput.snapshot = warmBase;
        else providerCreateInput.warmBaseSnapshot = warmBase;
      } else {
        providerCreateInput.snapshot = image.snapshotName;
      }
      console.log(
        `[session-sandbox] Booting ${sandbox.sandboxId} from ${image.snapshotName} ` +
        `(${warmBase ? 'warm base' : `template "${image.slug}"${image.isDefault ? ' [platform default]' : ''}`}, ` +
        `branch ${branch}, ${warmBase ? 'memory-restore' : image.built ? 'fresh build' : 'cache hit'})`,
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
        // The session was explicitly deleted while this box was still being
        // created — deletion is the one case where we remove the provider box.
        await provider.remove(result.externalId).catch((err) => {
          console.warn(`[session-sandbox] failed to remove deleted session sandbox ${result.externalId}:`, err);
        });
        await db
          .update(sessionSandboxes)
          .set({
            externalId: result.externalId,
            baseUrl: result.baseUrl || null,
            // 'archived', not 'stopped': the box is gone, so GET …/sandbox must
            // not try to resume it — it reprovisions fresh on reopen instead.
            status: 'archived',
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
        const stopTl = tl.summary();
        recordProviderEvent({
          provider: providerName, kind: 'provision', outcome: 'stopped',
          totalMs: stopTl.totalMs, marks: stopTl.marks, attempts,
          sessionId: sandbox.sandboxId, accountId,
        });
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
        config: { serviceKey: sandboxKey.secretKey, llmGatewayEnabled: !!gatewayLlmKey },
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

      // Project warm snapshot: the baked workspace is at BAKE-time tip. Fast-
      // forward it to the CURRENT base tip in the background so commits merged
      // since the bake are present.
      if (warmIsProjectSnapshot && result.externalId) {
        void import('../../snapshots/warm-project')
          .then(({ refreshRestoredWorkspace }) => refreshRestoredWorkspace(result.externalId, userId))
          .catch(() => {});
      }

      tl.mark('row-active');
      tl.log({ provider: providerName, attempts });

      const okTl = tl.summary();
      recordProviderEvent({
        provider: providerName, kind: 'provision', outcome: 'ok',
        totalMs: okTl.totalMs, marks: okTl.marks, attempts,
        sessionId: sandbox.sandboxId, accountId,
      });

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
      // Warm restore kept coming up without the baked runtime (Daytona's
      // experimental snapshot drops the filesystem layer ~half the time, and
      // createWarm exhausted its in-provider retries). Drop the warm path and
      // re-provision from the normal Dockerfile snapshot so the session still
      // starts — warm is a best-effort speedup, never a hard dependency.
      if (warmBase && bgErr instanceof WarmRuntimeUnavailableError) {
        console.warn(
          `[session-sandbox] warm runtime unavailable for ${sandbox.sandboxId} — falling back to the normal snapshot path:`,
          bgErr.message,
        );
        // Pause the warm path fleet-wide for a few minutes so subsequent
        // sessions skip the doomed warm attempt (e.g. region revoked).
        const { noteWarmPathFailure } = await import('../../snapshots/warm-bake');
        noteWarmPathFailure();
        warmBase = null;
        warmIsProjectSnapshot = false;
        providerCreateInput.warmBaseSnapshot = undefined;
        if (bgExternalId) {
          await provider.remove(bgExternalId).catch(() => {});
          bgExternalId = null;
        }
        imageInfo = null;
        tl.mark('warm-fallback');
        continue provisioning;
      }

      // Daytona dropped the image between resolve and create. Force a rebuild
      // (delete the snapshot so the next ensureSandboxImage call rebuilds it)
      // and retry once. Capped at one heal per session start. Never on the warm
      // path — there's no per-project Dockerfile snapshot to rebuild.
      if (!warmBase && isSnapshotMissingOnProvider(bgErr) && imageInfo && !healedStaleSnapshot) {
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

      // ── Provider failover (one-shot, on init) ────────────────────────────
      // Admin-gated (DB `provider_fallback`, OFF by default). When ON, a
      // provider that fails to provision the session AT BIRTH hands off ONCE to
      // the next allowed provider before the session is marked failed. Init
      // only — a running box is never migrated here. The new provider re-resolves
      // its own image (the snapshot is provider-specific), so we clear all image
      // state and re-enter the loop.
      if (!fallbackAttempted && providerFallbackSetting().enabled) {
        const next = config.ALLOWED_SANDBOX_PROVIDERS.find((p) => p !== providerName);
        if (next) {
          fallbackAttempted = true;
          console.warn(
            `[session-sandbox] ${providerName} provisioning failed for ${sandbox.sandboxId} — failing over to ${next}: ${bgMessage.slice(0, 160)}`,
          );
          const foTl = tl.summary();
          recordProviderEvent({
            provider: providerName, kind: 'provision', outcome: 'error',
            totalMs: foTl.totalMs, marks: foTl.marks,
            errorClass: 'other', error: `failover→${next}: ${bgMessage}`,
            sessionId: sandbox.sandboxId, accountId,
          });
          if (bgExternalId) {
            await provider.remove(bgExternalId).catch(() => {});
            bgExternalId = null;
          }
          providerName = next;
          provider = getProvider(next);
          warmBase = null;
          warmIsProjectSnapshot = false;
          providerCreateInput.snapshot = undefined;
          providerCreateInput.warmBaseSnapshot = undefined;
          firstImagePromise = null;
          imageInfo = null;
          healedStaleSnapshot = false;
          await db
            .update(sessionSandboxes)
            .set({ provider: next, status: 'provisioning', updatedAt: new Date() })
            .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId))
            .catch(() => {});
          tl.mark(`failover:${next}`);
          continue provisioning;
        }
      }

      // Provider-capacity errors (Daytona "No available runners", rate limits)
      // are transient outages, not session failures. Log them as a warning so
      // they don't read as code bugs in the console, and present a friendly
      // message to the user instead of the SDK stack trace.
      const isCapacity = /no available runner|no runners available|out of capacity|capacity exceeded|rate ?limit|too many requests/i.test(bgMessage);
      // Git auth / repo-access failures. These are NOT a provider fault — the
      // sandbox provider is fine; we couldn't clone the project's repo. Reporting
      // them as "Provisioning failed via daytona" actively misdirects debugging
      // (it reads as a Daytona outage), so categorize + surface them as a git
      // problem with an actionable message.
      const isGitAuth =
        /could not read Username|terminal prompts disabled|Authentication failed|fatal: could not read|Invalid username or password|remote: Repository not found|HTTP 401|HTTP 403|access denied|Permission denied \(publickey\)/i.test(
          bgMessage,
        );
      const failureCategory: 'provider-capacity' | 'git-auth' | null = isCapacity
        ? 'provider-capacity'
        : isGitAuth
          ? 'git-auth'
          : null;
      const userMessage = isCapacity
        ? 'The sandbox provider is at capacity right now. Try again in a minute.'
        : isGitAuth
          ? "Couldn't access the project's Git repository (authentication failed). Check the project's Git credentials and try again."
          : `Provisioning failed via ${providerName}.`;
      if (isCapacity) {
        console.warn(
          `[session-sandbox] provider at capacity for ${sandbox.sandboxId} after retries — bouncing session:`,
          bgMessage.slice(0, 200),
        );
      } else if (isGitAuth) {
        console.error(
          `[session-sandbox] git auth/repo-access failure provisioning ${sandbox.sandboxId} (not a provider fault):`,
          bgMessage.slice(0, 300),
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
              ...(failureCategory ? { failureCategory } : {}),
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
      // Tell the originating channel (Slack) so the live thread shows the friendly
      // reason now instead of a stranded ⏳ until the 30-min GC. Fire-and-forget;
      // a no-op for non-channel sessions.
      notifySessionProvisioningFailed(sandbox.sandboxId, userMessage);
      const errTl = tl.summary();
      recordProviderEvent({
        provider: providerName, kind: 'provision', outcome: 'error',
        totalMs: errTl.totalMs, marks: errTl.marks,
        errorClass: isCapacity ? 'capacity' : 'other', error: bgMessage,
        sessionId: sandbox.sandboxId, accountId,
      });
      break provisioning;
    }
    }
  })();

  return { row: sandbox, created: true };
}
