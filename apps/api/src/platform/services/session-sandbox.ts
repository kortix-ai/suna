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

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { PROVISIONING_SESSION_STATUSES } from '../../projects/lib/session-status';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { createApiKey } from '../../repositories/api-keys';
import { createAccountToken } from '../../repositories/account-tokens';
import { ensureAgentServiceAccount } from '../../repositories/service-accounts';
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
import { providerFallbackSetting } from './runtime-settings';
import { selectProvider } from './provider-balancer';
import { ProvisionTimeline } from './provision-timeline';
import { recordProviderEvent } from './provider-events';
import type { GitBackedProject } from '../../projects/git';
import { startComputeSession } from '../../billing/services/compute-metering';
import { accountEntitledToLlmGateway } from '../../shared/account-limits';
import { readManifest } from '../../projects/triggers';
import { resolveAgentGrant } from '../../projects/agents';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { RuntimeIdentityConflictError } from '../../projects/runtime-identity-error';

// Fallback spec for sandboxes that don't declare `sandbox:` in kortix.yaml.
// Mirrors the platform default sandbox size (2 vCPU / 4 GB / 20 GB).
const DEFAULT_METERING_SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

async function openComputeSessionForSandbox(
  sandboxId: string,
  accountId: string,
  project: GitBackedProject,
  userId: string | null | undefined,
  sandboxSlug: string | undefined,
  provider: ProviderName,
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
    provider,
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
  // Resolve the per-session grant AND the agent's standing-identity service
  // account in parallel. The SA resolution is FAIL-SAFE: on error we mint
  // without a service_account_id, which is the legacy behavior (authorize as the
  // user ∩ grant) — it never WIDENS, so a provisioning hiccup degrades to the
  // previous secure model rather than breaking session start.
  const [agentGrant, serviceAccountId] = await Promise.all([
    resolveAgentGrant(opts.agentName, opts.gitProject).catch((err) => {
      console.warn(`[session-sandbox] failed to resolve agent grant for ${opts.projectId}:`, err);
      return null;
    }),
    ensureAgentServiceAccount({
      accountId: opts.accountId,
      projectId: opts.projectId,
      agentName: opts.agentName,
    }).catch((err) => {
      console.warn(`[session-sandbox] failed to ensure agent service account for ${opts.projectId}:`, err);
      return null;
    }),
  ]);
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
      serviceAccountId,
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
   * Runs after the provider sandbox is created but BEFORE the row is flipped to
   * `active`. Used by legacy migration to restore the original opencode store
   * into the sandbox before the frontend's `ensure-opencode` pin runs (which
   * would otherwise re-pin to a fresh session). Best-effort: a throw is logged
   * and provisioning still completes to `active`.
   */
  beforeActive?: (externalId: string) => Promise<void>;
}): Promise<ProvisionSessionSandboxResult> {
  const { sandboxId, accountId, projectId, userId, serverType, location } = opts;
  const providerWasExplicitlySelected = opts.provider !== undefined;
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
  // Cold-only: every session boots from its Dockerfile snapshot (the shared
  // default or a per-project template), resolved by ensureSandboxImage. No warm
  // / stateful-snapshot fast path — Platinum and Daytona take the identical cold
  // path.
  let firstImagePromise: Promise<FirstImage> | null = (async () => {
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
  const llmGatewayEnabled = projectLlmGatewayEnabled(opts.projectMetadata);
  const createOrClaimSandboxRow = async () => {
    const inserted = await db
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
      .onConflictDoNothing({ target: sessionSandboxes.sessionId })
      .returning();
    if (inserted.length > 0) return inserted;

    // Provider-confirmed loss keeps the durable logical row because DB-level
    // identity guards and child records intentionally forbid deleting it. The
    // recovery transaction resets external_id to NULL and stamps an explicit
    // authorization marker; only that exact placeholder may be claimed here.
    return db
      .update(sessionSandboxes)
      .set({
        provider: providerName,
        status: 'provisioning',
        baseUrl: null,
        config: {},
        // Legacy recovery placeholders may still exist while this release rolls
        // out. Consume their authorization marker atomically so at most one
        // allocator can claim the row and call provider.create(). New code never
        // creates this marker because established identities are fail-closed.
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'identityRecoveryAuthorizedAt'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          isNull(sessionSandboxes.externalId),
          eq(sessionSandboxes.status, 'provisioning'),
          sql`coalesce(${sessionSandboxes.metadata}->>'identityRecoveryAuthorizedAt', '') <> ''`,
        ),
      )
      .returning();
  };

  const [sandboxRows, sandboxKey, executorToken, gatewayEntitled] = await Promise.all([
    createOrClaimSandboxRow(),
    createApiKey({
      sandboxId,
      accountId,
      title: 'Sandbox Token',
      type: 'sandbox',
    }),
    // Resolve the per-agent grant from kortix.yaml's `agents:` overlay and mint
    // the executor/CLI account token carrying it (best-effort — see helper).
    mintExecutorToken({
      accountId,
      userId,
      projectId,
      sandboxId,
      agentName: opts.agentName ?? 'default',
      gitProject: opts.gitProject,
    }),
    llmGatewayEnabled
      ? accountEntitledToLlmGateway(accountId).catch((err) => {
          console.warn(
            `[session-sandbox] failed to resolve LLM-gateway entitlement for ${userId}@${accountId}:`,
            err instanceof Error ? err.message : String(err),
          );
          return false;
        })
      : Promise.resolve(false),
  ]);
  const [sandbox] = sandboxRows;
  if (!sandbox) throw new RuntimeIdentityConflictError(sandboxId);
  tl.mark('row+tokens');

  const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
  const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  const llmBaseUrl =
    config.LLM_GATEWAY_BASE_URL ||
    (llmProxyMode ? `${kortixOrigin}/v1/llm-gateway/v1/llm` : `${kortixOrigin}/v1/llm`);

  // The sandbox's OpenCode `kortix` provider only mounts when KORTIX_LLM_* is
  // injected (otherwise OpenCode falls back to showing only its built-in Zen
  // catalog). It authenticates the gateway with the per-session executor PAT,
  // which the gateway resolves via validateAccountToken and meters.
  //
  // YOLO is gone — we no longer mint/inject a per-member kyolo_ token here. That
  // path was a single row per member, re-minted on every provision, so concurrent
  // boots clobbered each other and left older sandboxes with a stale token the
  // gateway rejects (401). The PAT is per-session and stable.
  //
  // Enablement is a three-part gate: operator availability, per-project
  // experimental opt-in, and account entitlement. If any part is off we inject
  // no KORTIX_LLM_* env, so OpenCode stays on its native provider behavior.
  // accountEntitledToLlmGateway gates on the resolved TIER, not billing_model,
  // so legacy paying customers are no longer wrongly stripped to the Zen-only
  // catalog. Per-request affordability stays in the gateway's own billing gate.
  const gatewayLlmKey: string | null =
    llmGatewayEnabled && gatewayEntitled ? executorToken : null;

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
    // reaper stays as a secondary backstop only.
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
      if (firstImagePromise) {
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
        .select({ status: projectSessions.status, metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, sandbox.sandboxId))
        .limit(1);
      const currentSessionMetadata =
        (currentSession?.metadata as Record<string, unknown> | null) ?? {};
      if (typeof currentSessionMetadata.deletedAt === 'string') {
        // Only an explicit deletion authorizes provider removal. A normal stop
        // uses the same status and must never be mistaken for deletion.
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
              providerExternalId: result.externalId,
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

      if (currentSession?.status === 'stopped') {
        // A manual stop or idle reconciliation won while provider.create was
        // in flight. Preserve the disk/identity and power it down.
        await provider.stop(result.externalId).catch((err) => {
          console.warn(
            `[session-sandbox] failed to stop concurrently-paused sandbox ${result.externalId}:`,
            err,
          );
        });
        await db
          .update(sessionSandboxes)
          .set({
            externalId: result.externalId,
            baseUrl: result.baseUrl || null,
            status: 'stopped',
            metadata: {
              ...buildSandboxInitSuccessMetadata(
                sandbox.metadata as Record<string, unknown> | null,
                {
                  ...result.metadata,
                  provisionTimeline: timeline,
                  providerExternalId: result.externalId,
                },
                attempts,
              ),
              stoppedDuringProvisioning: true,
              stoppedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
        tl.mark('row-stopped-during-provision');
        tl.log({ provider: providerName, attempts, stoppedDuringProvisioning: true });
        const stoppedTl = tl.summary();
        recordProviderEvent({
          provider: providerName, kind: 'provision', outcome: 'stopped',
          totalMs: stoppedTl.totalMs, marks: stoppedTl.marks, attempts,
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
            providerExternalId: result.externalId,
            runtimeArtifact: {
              artifactType: providerName === 'daytona' ? 'daytona_snapshot' : `${providerName}_template`,
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
        // provider provisioning status does not gate this table; the frontend's
        // own readiness poller validates port 8000.
        finishUpdate.status = 'active';
      }

      // Conditional finish: `deleteSession()` is the ONLY place that sets a
      // session_sandboxes row to 'archived', and it does so as soon as the
      // user deletes the session — even while this provisioning IIFE is still
      // in flight. Guard the write so a late-finishing provision can never
      // resurrect a tombstoned row. If no row comes back, the session was
      // deleted mid-provision: remove the box we just created and stop —
      // no 'running' flip, no compute metering.
      const [finished] = await db
        .update(sessionSandboxes)
        .set(finishUpdate)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandbox.sandboxId),
            ne(sessionSandboxes.status, 'archived'),
          ),
        )
        .returning();

      if (!finished) {
        console.warn(
          `[session-sandbox] session ${sandbox.sandboxId} was deleted mid-provision — removing box ${result.externalId} instead of finishing provisioning`,
        );
        await provider.remove(result.externalId).catch((err) =>
          console.warn(
            `[session-sandbox] cleanup of ${result.externalId} after mid-provision delete failed:`,
            err,
          ),
        );
        tl.mark('row-deleted-mid-provision');
        tl.log({ provider: providerName, attempts, deletedMidProvision: true });
        const delTl = tl.summary();
        recordProviderEvent({
          provider: providerName, kind: 'provision', outcome: 'stopped',
          totalMs: delTl.totalMs, marks: delTl.marks, attempts,
          sessionId: sandbox.sandboxId, accountId,
        });
        return;
      }

      // Mirror sandbox readiness onto the project_sessions row so the
      // sidebar's status dot stops spinning. session_id == sandbox_id by
      // construction, so the lookup is direct. Only flip sessions that are
      // still genuinely mid-provision (queued/branching/provisioning) —
      // 'stopped' (deleted, or an explicit stop) and 'running' (won by the
      // separate stopped→running resume path in routes/shared.ts) must not be
      // clobbered back to 'running' by a provisioning attempt finishing late.
      await db
        .update(projectSessions)
        .set({
          status: 'running',
          sandboxUrl: result.baseUrl || null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectSessions.sessionId, sandbox.sandboxId),
            inArray(projectSessions.status, [...PROVISIONING_SESSION_STATUSES]),
          ),
        )
        .catch(() => {});

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
      void openComputeSessionForSandbox(sandbox.sandboxId, accountId, opts.gitProject, userId, imageInfo?.slug, providerName).catch(
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

      // ── Provider failover (one-shot, on init) ────────────────────────────
      // Admin-gated (DB `provider_fallback`, OFF by default). When ON, a
      // provider that fails to provision the session AT BIRTH hands off ONCE to
      // the next allowed provider before the session is marked failed. Init
      // only — a running box is never migrated here. The new provider re-resolves
      // its own image (the snapshot is provider-specific), so we clear all image
      // state and re-enter the loop.
      if (!providerWasExplicitlySelected && !fallbackAttempted && providerFallbackSetting().enabled) {
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
          providerCreateInput.snapshot = undefined;
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
