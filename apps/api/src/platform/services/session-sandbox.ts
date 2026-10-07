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

import { and, eq, isNull, sql } from 'drizzle-orm';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { isMetaAgentName, META_SANDBOX_SLUG } from '@kortix/shared';
import { db } from '../../shared/db';
import {
  patchedSandboxMetadata,
  transitionSandbox,
  transitionSession,
} from '../../projects/session-lifecycle/status-transitions';
import { signalSessionRuntimeActive } from '../../projects/session-lifecycle/runtime-active-signal';
import { nextFailoverProvider } from '../../projects/lib/provider-precedence';
import { notifySessionProvisioningFailed } from '../../shared/session-failure-notifier';
import { createAccountToken } from '../../repositories/account-tokens';
import { ensureAgentServiceAccount } from '../../repositories/service-accounts';
import {
  getProvider,
  SandboxTemplateNotFoundError,
  type CreateSandboxOpts,
  type ProvisionResult,
  type ProviderName,
} from '../providers';
import {
  readActiveRouting,
  type ActiveRouting,
} from '../../projects/provider-transition/provider-transition-store';
import {
  buildSandboxInitAttemptMetadata,
  buildSandboxInitFailureMetadata,
  buildSandboxInitSuccessMetadata,
  retrySandboxProvisionCreate,
  SANDBOX_INIT_MAX_ATTEMPTS,
  sandboxInitMetadataPatch,
} from './sandbox-init-state';
import {
  ensureSandboxImage,
  ensureMetaSandboxImage,
  deleteSandboxImage,
  resolveTemplate,
  DEFAULT_SANDBOX_SLUG,
  type EnsureSandboxImageResult,
  type SandboxImageSpec,
} from '../../snapshots/builder';
import { config } from '../../config';
import { providerFallbackSetting } from './runtime-settings';
import { selectProvider } from './provider-balancer';
import { ProvisionTimeline } from './provision-timeline';
import { recordProviderEvent } from './provider-events';
import type { GitBackedProject } from '../../projects/git';
import { startComputeSession } from '../../billing/services/compute-metering';
import { readManifest } from '../../projects/triggers';
import { resolveAgentGrant } from '../../projects/agents';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import { RuntimeIdentityConflictError } from '../../projects/runtime-identity-error';
import { grantWarmPoolLifetime } from '../../projects/sandbox-deadline';
import { instanceStampMetadata } from '../../projects/instance-scope';
import { withTimeout, configuredTimeoutMs } from '../../shared/with-timeout';
import { classifySandboxProvisioningFailure } from './sandbox-provisioning-error';
import { platformMetaAgentGrant } from '../../projects/lib/platform-meta-agent';
import { resolveSessionOnBehalfOf } from '../../projects/lib/on-behalf-of';
import { agentPrincipalModeFor } from '../../iam/agent-principal';
import { resolveSessionNetworkBoundary } from '../../projects/lib/network-secret-boundary';
import {
  type PreparedInitialSandboxTurn,
  initialSandboxTurnMetadata,
} from '../../projects/session-turn-ledger';
import { resolveSessionSandboxRegion } from './sandbox-region';
import { logger } from '../../lib/logger';

/**
 * Bound for the pre-active hook. Generous, because the hook is a data restore and
 * cutting it short mid-write is worse than waiting — but finite, because it sits
 * between "VM exists" and "row is active", i.e. directly on time-to-usable. See
 * the call site for the measured cost of it being unbounded.
 */
const BEFORE_ACTIVE_HOOK_TIMEOUT_MS = configuredTimeoutMs(
  'KORTIX_BEFORE_ACTIVE_HOOK_TIMEOUT_MS',
  20_000,
  1_000,
);

// Fallback spec for sandboxes that don't declare `sandbox:` in kortix.yaml.
// Mirrors the platform default sandbox size (2 vCPU / 4 GB / 20 GB).
const DEFAULT_METERING_SPEC = { cpuCores: 2, memoryGb: 4, diskGb: 20, gpuCount: 0 };

/**
 * The spec compute metering bills a session at.
 *
 * The image that booted is the authority: the provider allocates the box from
 * the size that image was built with. Meta images are built at
 * 1 vCPU / 2 GB / 8 GB and have no project template, so a template lookup for
 * them always failed and billed the 2 / 4 / 20 fallback instead.
 */
export function computeMeteringSpec(
  imageSpec: SandboxImageSpec | null | undefined,
  templateSpec: Partial<SandboxImageSpec> | null,
): typeof DEFAULT_METERING_SPEC {
  const source = imageSpec ?? templateSpec;
  const spec = { ...DEFAULT_METERING_SPEC };
  if (source?.cpu !== undefined) spec.cpuCores = source.cpu;
  if (source?.memoryGb !== undefined) spec.memoryGb = source.memoryGb;
  if (source?.diskGb !== undefined) spec.diskGb = source.diskGb;
  return spec;
}

async function openComputeSessionForSandbox(
  sandboxId: string,
  accountId: string,
  project: GitBackedProject,
  userId: string | null | undefined,
  sandboxSlug: string | undefined,
  provider: ProviderName,
  imageSpec: SandboxImageSpec | null | undefined,
): Promise<void> {
  let templateSpec: Partial<SandboxImageSpec> | null = null;
  if (!imageSpec) {
    try {
      const tpl = await resolveTemplate(project, sandboxSlug);
      templateSpec = { cpu: tpl.cpu, memoryGb: tpl.memoryGb, diskGb: tpl.diskGb };
    } catch {
      // Template resolution failed (repo unreachable, parse error, etc.). Fall
      // back to defaults so metering still records the session.
    }
  }
  const spec = computeMeteringSpec(imageSpec, templateSpec);
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
 * the per-session account token carrying it. Grant resolution is fail-closed:
 * an unreadable manifest stops provisioning instead of minting an unrestricted
 * credential. The grant is read from the default branch, so any `[[agents]]`
 * change activates only through a merged change request.
 */
export async function mintSessionToken(opts: {
  accountId: string;
  userId: string;
  projectId: string;
  sandboxId: string;
  agentName: string;
  gitProject: GitBackedProject;
}): Promise<string> {
  const platformMetaAgent = isMetaAgentName(opts.agentName);
  // The reserved coordinator uses a platform-owned full project grant. It acts
  // as the launching user and never resolves through a project-declared agent
  // or standing service account.
  const [agentGrant, serviceAccountId] = platformMetaAgent
    ? [platformMetaAgentGrant(), null]
    : await Promise.all([
        // Resolve the per-session grant AND the agent's standing-identity
        // service account in parallel. Grant resolution must throw on failure.
        // The SA resolution is FAIL-SAFE: on error
        // we mint without a service_account_id, which is the legacy behavior
        // (authorize as the user ∩ grant). It never widens authority.
        resolveAgentGrant(opts.agentName, opts.gitProject),
        ensureAgentServiceAccount({
          accountId: opts.accountId,
          projectId: opts.projectId,
          agentName: opts.agentName,
        }).catch((err) => {
          console.warn(
            `[session-sandbox] failed to ensure agent service account for ${opts.projectId}:`,
            err,
          );
          return null;
        }),
      ]);
  // Agents as principals (spec 2026-09-22 §2.1): with the project flag on, a
  // governed agent authorizes AS its service account. A token without one would
  // fall back to the launcher — for an unattended run, the account OWNER — so
  // under the flag a missing service account stops provisioning instead.
  const [agentPrincipal, onBehalfOfUserId] = await Promise.all([
    agentPrincipalModeFor(opts.projectId, agentGrant),
    resolveSessionOnBehalfOf({ accountId: opts.accountId, sessionId: opts.sandboxId, userId: opts.userId }),
  ]);
  if (agentPrincipal && !serviceAccountId) {
    throw new Error(
      `project ${opts.projectId}: governed agent "${opts.agentName}" has no service account; ` +
        'refusing to mint a session credential that would authorize as the launcher',
    );
  }
  const tok = await createAccountToken({
    accountId: opts.accountId,
    userId: opts.userId,
    projectId: opts.projectId,
    // session_id == sandbox_id by construction. This is the sandbox's one
    // Kortix credential. Every API surface derives its narrower authority from
    // these claims and the route's own authorization gate.
    sessionId: opts.sandboxId,
    name: `Session ${opts.sandboxId.slice(0, 8)}`,
    agentGrant,
    serviceAccountId,
    onBehalfOfUserId,
  });
  return tok.secretKey;
}

/**
 * FIX-A kill-switch. Default ON: boot by the activated pinned template id, with
 * a name-boot fallback ONLY on a definitive GC'd-pin 404. Set
 * `KORTIX_SESSION_BOOT_BY_TEMPLATE_ID=0` (or off/false/no) to revert to the
 * name-only boot — the safe escape hatch for the first rollout.
 */
export function sessionBootByTemplateIdEnabled(): boolean {
  const raw = (process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

/**
 * FIX-A: decide whether this boot should use the pinned EXACT template id. Pure
 * (no I/O) so the gate is unit-testable. Returns the id ONLY when every guard
 * holds:
 *   - the kill-switch is ON,
 *   - the provider actually supports id-boot (Platinum; others are name-only),
 *   - a non-empty pinned id exists, AND
 *   - the activation records an image name that exactly matches the resolved
 *     image name, AND
 *   - MANDATORY provider-match: the pin belongs to the provider it was activated
 *     for — `routing.activeProvider === providerName`. This is what makes a
 *     rollback safe: a project reverted to Daytona with a leftover Platinum id
 *     pin (activeProvider='daytona') booting a Daytona session must use the NAME,
 *     never the stale Platinum id.
 * `disabledForSession` lets the caller drop to name-boot after a 404 fallback.
 */
export function decideSessionBoot(input: {
  killSwitchOn: boolean;
  routing: Pick<
    ActiveRouting,
    'activeProvider' | 'activeExternalTemplateId' | 'activeSnapshotName'
  > | null;
  providerName: string;
  providerSupportsIdBoot: boolean;
  imageIsDefault?: boolean;
  imageSnapshotName?: string;
  disabledForSession?: boolean;
}): { bootByTemplateId: string | null } {
  const {
    killSwitchOn,
    routing,
    providerName,
    providerSupportsIdBoot,
    imageIsDefault = true,
    imageSnapshotName,
    disabledForSession,
  } = input;
  if (
    disabledForSession ||
    !killSwitchOn ||
    !providerSupportsIdBoot ||
    !imageIsDefault
  ) {
    return { bootByTemplateId: null };
  }
  const pinnedId = routing?.activeExternalTemplateId ?? null;
  if (!pinnedId) return { bootByTemplateId: null };
  if (routing?.activeProvider !== providerName) return { bootByTemplateId: null }; // provider-match
  if (
    !routing.activeSnapshotName ||
    !imageSnapshotName ||
    routing.activeSnapshotName !== imageSnapshotName
  ) {
    return { bootByTemplateId: null };
  }
  return { bootByTemplateId: pinnedId };
}

/**
 * S1 (Platinum idempotent create): derive the starting point for the
 * MONOTONIC `platinumCreateAttempt` counter from a session_sandboxes row's
 * persisted metadata. Pure (no I/O) so the "never resets across a process
 * restart" guarantee is unit-testable without spinning up the whole
 * provisioning IIFE — mirrors decideSessionBoot's pure-gate pattern above.
 *
 * Returns 0 for a fresh row (no attempt persisted yet) or any
 * malformed/negative value; the caller then starts counting from 1. For a
 * RESUMED row (a previous process persisted e.g. `platinumCreateAttempt: 2`
 * before crashing/restarting mid-attempt), returns that SAME value — the
 * caller's first provisioning pass reuses attempt 2 as-is (so if that
 * attempt's create had actually already committed server-side, Platinum's
 * Idempotency-Key replay adopts it) rather than jumping straight to 3, which
 * would mint a fresh, unrelated create identity and could orphan a live box.
 */
export function restorePlatinumCreateAttempt(metadata: Record<string, unknown> | null | undefined): number {
  const raw = metadata?.platinumCreateAttempt;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

type ProvisionSessionSandboxOpts = Parameters<typeof provisionSessionSandbox>[0];
type SessionSandboxRow = typeof sessionSandboxes.$inferSelect;
type SessionSandboxProvider = ReturnType<typeof getProvider>;
type ProvisioningStage = SessionSandboxProvider['provisioning']['stages'][number] | undefined;
type ProvisionTimelineSummary = ReturnType<ProvisionTimeline['summary']>;
type FirstImage = EnsureSandboxImageResult & { gitProject: GitBackedProject };

/** Mutable state of one provisionSessionSandbox() call, shared by its detached loop. */
interface SessionProvisionState {
  // Provider failover (one-shot, admin-gated) reassigns these two in the
  // provision loop's catch when the primary fails at birth.
  providerName: ProviderName;
  provider: SessionSandboxProvider;
  firstImagePromise: Promise<FirstImage> | null;
  bgExternalId: string | null;
  // Single retry hook: if Daytona's sandbox.create races a snapshot deletion
  // and reports "not found", we rebuild and retry once. More than once means
  // something is genuinely broken — surface the error.
  healedStaleSnapshot: boolean;
  // Provider failover (one-shot, on init): set true once we've handed off to a
  // second provider, so a session never bounces between providers forever.
  fallbackAttempted: boolean;
  imageInfo: {
    snapshotName: string;
    slug: string;
    contentHash: string;
    isDefault: boolean;
    runtimeProfile?: 'standard' | 'meta';
    spec?: SandboxImageSpec;
  } | null;
  activeRouting: ActiveRouting | null;
  idBootDisabled: boolean;
  lastProvisionAttempt: number;
  lastProvisionMaxAttempts: number;
  platinumCreateAttempt: number;
}

/** What the detached provisioning loop reads but never changes. */
interface SessionProvisionContext {
  opts: ProvisionSessionSandboxOpts;
  sandbox: SessionSandboxRow;
  sessionToken: string;
  providerCreateInput: CreateSandboxOpts;
  tl: ProvisionTimeline;
  llmGatewayEnabled: boolean;
  providerWasExplicitlySelected: boolean;
  resolveGitProject: () => Promise<GitBackedProject>;
  resolveImage: (gitProject: GitBackedProject, targetProvider: string) => Promise<EnsureSandboxImageResult>;
}

/** Insert the `provisioning` row, or claim an authorized recovery placeholder. */
async function createOrClaimSessionSandboxRow(
  opts: ProvisionSessionSandboxOpts,
  state: SessionProvisionState,
): Promise<SessionSandboxRow[]> {
  const { sandboxId, accountId, projectId } = opts;
  const inserted = await db
    .insert(sessionSandboxes)
    .values({
      sandboxId,
      sessionId: sandboxId,
      accountId,
      projectId,
      provider: state.providerName,
      externalId: null,
      status: 'provisioning',
      baseUrl: null,
      config: {},
      metadata: {
        ...(opts.metadata ?? {}),
        // Instance scope for background work on a shared DB — see
        // projects/instance-scope.ts. `{}` when KORTIX_INSTANCE_ID is unset.
        ...instanceStampMetadata(),
        ...(opts.initialTurn
          ? {
              activeTurns: {
                [opts.initialTurn.token]: initialSandboxTurnMetadata(opts.initialTurn),
              },
            }
          : {}),
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
  // Legacy recovery placeholders may still exist while this release rolls
  // out. Consume their authorization marker atomically so at most one
  // allocator can claim the row and call provider.create(). New code never
  // creates this marker because established identities are fail-closed.
  const claimed = await transitionSandbox('reprovision', sandboxId, {
    columns: { provider: state.providerName, baseUrl: null, config: {} },
    metadata: { strip: ['identityRecoveryAuthorizedAt'], merge: instanceStampMetadata() },
    guard: and(
      eq(sessionSandboxes.status, 'provisioning'),
      isNull(sessionSandboxes.externalId),
      sql`coalesce(${sessionSandboxes.metadata}->>'identityRecoveryAuthorizedAt', '') <> ''`,
    ),
  });
  return claimed ? [claimed] : [];
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
  /**
   * Is `provider` a HARD requirement (explicit request, project pin, or an
   * existing box restarting on its own runtime) or merely the weighted
   * balancer's pick? Omitted ⇒ locked whenever `provider` is set, which keeps
   * every legacy caller's behavior unchanged. Callers that pass the BALANCER's
   * choice must pass `false`, or one-shot failover can never run for them.
   */
  providerLocked?: boolean;
  serverType?: string;
  location?: string;
  metadata?: Record<string, unknown>;
  /** Pre-created authority for a prompt the daemon delivers during boot. */
  initialTurn?: PreparedInitialSandboxTurn | null;
  /** Project metadata, used for per-project experimental gates. */
  projectMetadata?: unknown;
  /** False for meta/read/runtime sessions that may not receive repository bytes. */
  allowProjectImage?: boolean;
  /**
   * Extra env vars injected into the sandbox at provider create-time. These
   * land in the Daytona snapshot's environment so its boot script can read
   * them (e.g. `KORTIX_PROJECT_REPO_URL`, `KORTIX_PROJECT_BRANCH`).
   *
   * A promise is awaited only where the provider input is built, so the env
   * build overlaps the image check, the row insert and the token mint. None of
   * the three reads it.
   */
  extraEnvVars?: Record<string, string> | Promise<Record<string, string>>;
  /**
   * Project + ref the session boots against. The boot path resolves the
   * commit SHA for `baseRef` and asks the snapshot builder for the matching
   * Daytona image — building inline if it doesn't exist yet. When `baseRef`
   * is omitted, defaults to `gitProject.defaultBranch`.
   */
  gitProject: GitBackedProject;
  resolveGitProject?: () => Promise<GitBackedProject>;
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
  const { sandboxId, accountId, projectId, userId, serverType } = opts;
  // An explicit caller location wins; otherwise the project's `us_region`
  // flag decides (sandbox-region.ts). Only Platinum reads it.
  const location = opts.location ?? resolveSessionSandboxRegion(opts.projectMetadata);
  const providerWasExplicitlySelected = opts.providerLocked ?? opts.provider !== undefined;
  // Resolution order:
  //   1. Explicit per-request `opts.provider` (set by callers that need a
  //      specific runtime, e.g. when restarting an existing sandbox).
  //   2. `config.getDefaultProvider()` — head of ALLOWED_SANDBOX_PROVIDERS.
  // `providerName` and `provider` live in `state`, not in `const`s: provider
  // failover (one-shot, admin-gated) reassigns them in the provision loop's
  // catch when the primary fails at birth.
  // Observed here so an env build that fails early is not an unhandled
  // rejection before the await below.
  const extraEnvRead = Promise.resolve(opts.extraEnvVars ?? {});
  extraEnvRead.catch(() => undefined);
  const providerName = opts.provider || (await selectProvider());
  const state: SessionProvisionState = {
    providerName,
    provider: getProvider(providerName),
    firstImagePromise: null,
    bgExternalId: null,
    healedStaleSnapshot: false,
    fallbackAttempted: false,
    imageInfo: null,
    activeRouting: null,
    idBootDisabled: false,
    lastProvisionAttempt: SANDBOX_INIT_MAX_ATTEMPTS,
    lastProvisionMaxAttempts: SANDBOX_INIT_MAX_ATTEMPTS,
    platinumCreateAttempt: 0,
  };
  const tl = new ProvisionTimeline(sandboxId, 'provision');

  const slug = (opts.sandboxSlug ?? '').trim() || DEFAULT_SANDBOX_SLUG;
  // Resolve the project + fresh provider-neutral git access (the snapshot
  // builder may need it to read the repo's Dockerfile).
  const resolveGitProject = async (): Promise<GitBackedProject> => {
    if (!opts.resolveGitProject) return opts.gitProject;
    return opts.resolveGitProject();
  };
  const resolveImage = (
    gitProject: GitBackedProject,
    targetProvider: string,
  ): Promise<EnsureSandboxImageResult> =>
    slug === META_SANDBOX_SLUG
      ? ensureMetaSandboxImage({ source: 'session-start', provider: targetProvider })
      : ensureSandboxImage(gitProject, {
          slug,
          accountId,
          source: 'session-start',
          provider: targetProvider,
          allowProjectImage: opts.allowProjectImage,
        });

  // Kick image resolution off NOW, in parallel with the token round-trip below.
  // The snapshot identity + provider cache-check depend only on the repo
  // contents — never on the freshly-minted session tokens — so there is no
  // reason to wait for the tokens before asking the provider whether the image
  // already exists. On the warm path this overlaps the ~200ms token round-trip
  // with the ~100-300ms cache-check, taking the smaller off the critical path.
  // Cold-only: every session boots from its Dockerfile snapshot (the shared
  // default or a per-project template), resolved by ensureSandboxImage. No warm
  // / stateful-snapshot fast path — Platinum and Daytona take the identical cold
  // path.
  state.firstImagePromise = (async () => {
    const gitProject = await resolveGitProject();
    // Parallel branch: note() keeps the main path's deltas truthful. These two
    // marks split what used to show up as one opaque `image-cached` wait.
    tl.note('image:git-project');
    const image = await resolveImage(gitProject, state.providerName);
    tl.note('image:resolved');
    return { ...image, gitProject };
  })();
  // Swallow the unhandled-rejection warning; the IIFE's try/catch owns the error
  // when it awaits the promise.
  state.firstImagePromise?.catch(() => {});

  // Sandbox-row insert + tokens + credit lookup all run in parallel. None of
  // them depend on the others — `sandboxId` is known up front, so even the
  // sandbox API key can be minted before the row lands. Previously serial
  // (~100ms each on a warm DB), now ~one round-trip total.
  const sandboxName = `session-${sandboxId.slice(0, 8)}`;
  const llmGatewayEnabled = projectLlmGatewayEnabled(opts.projectMetadata);
  const [sandboxRows, sessionToken] = await Promise.all([
    createOrClaimSessionSandboxRow(opts, state),
    // Resolve the per-agent grant and mint the sole sandbox credential. Token
    // minting is fail-closed: a sandbox without its session identity cannot
    // securely reach any Kortix service.
    mintSessionToken({
      accountId,
      userId,
      projectId,
      sandboxId,
      agentName: opts.agentName ?? 'default',
      gitProject: opts.gitProject,
    }),
  ]);
  const [sandbox] = sandboxRows;
  if (!sandbox) throw new RuntimeIdentityConflictError(sandboxId);
  // A WARM-POOL box is the one box the control plane can never observe again
  // until somebody claims it: no turns, no LLM calls, no human preview traffic.
  // Under the bare 20-minute boot floor every warm box was therefore reaped
  // before it could be handed out, which defeats the whole feature. Grant its
  // (bounded) lifetime here, at the one moment we know it is warm. No-op for
  // every other box, and fire-and-forget: the row already carries the floor.
  void grantWarmPoolLifetime(sandboxId, sandbox.metadata);
  tl.mark('row+tokens');

  const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
  const llmBaseUrl = resolveLlmGatewayBaseUrl(kortixOrigin);

  // The sandbox's OpenCode `kortix` provider only mounts when KORTIX_LLM_* is
  // injected (otherwise OpenCode falls back to showing only its built-in Zen
  // catalog). It authenticates the gateway with the per-session connector PAT,
  // which the gateway resolves via validateAccountToken and meters.
  //
  // YOLO is gone — we no longer mint/inject a per-member kyolo_ token here. That
  // path was a single row per member, re-minted on every provision, so concurrent
  // boots clobbered each other and left older sandboxes with a stale token the
  // gateway rejects (401). The PAT is per-session and stable.
  //
  // Enablement is the project's `llm_gateway` flag alone (operator
  // availability + per-project opt-in), the same rule prompt-time env-sync
  // applies (sandbox-env-sync.ts). The account's plan is NOT a boot gate: the
  // gateway limits a free account to free/BYOK models per request
  // (principal.freeModelsOnly, resolve-candidates.ts). Gating boot on the plan
  // booted free accounts without the gateway; OpenCode recovered on the first
  // prompt's env-sync, but pi has no native path and never started.

  const extraEnvVars = await extraEnvRead.catch(async (error) => {
    // The row exists and no box ever will: close it. The caller fails the session.
    await transitionSandbox('failProvisioning', sandbox.sandboxId).catch(() => null);
    throw error;
  });

  const providerCreateInput: CreateSandboxOpts = {
    accountId,
    userId,
    name: sandboxName,
    // S1: the FULL logical sandbox id — NEVER `sandboxName` above, which is
    // truncated to 8 chars for display and is not a safe create-dedup key.
    // `createAttempt` is set below, before the provisioning loop, and bumped
    // only at the specific "this is a genuinely new attempt" transitions.
    sandboxId: sandbox.sandboxId,
    serverType,
    location,
    envVars: {
      ...extraEnvVars,
      // One sandbox, one session-scoped Kortix credential. Provider, connector,
      // executor and Git credentials stay server-side. The route being called
      // determines what this token may do.
      KORTIX_TOKEN: sessionToken,
      ...(llmGatewayEnabled ? { KORTIX_LLM_BASE_URL: llmBaseUrl } : {}),
    },
    // Idle lifecycle: we pass NO explicit autoStopInterval for a normal session,
    // so each provider gets its native idle timer set from
    // providerAutoStopBackstopMinutes() (Daytona → daytonaLifecycle(); Platinum →
    // auto_stop_minutes). That timer is a LAST-RESORT backstop for a box this API
    // can no longer reach — 12h, deliberately far above any real turn, because it
    // sees only inbound traffic and nothing resets it during a local tool run.
    // The primary stop is `deadline_at` (projects/sandbox-deadline.ts), enforced
    // by the reaper. Platinum NO LONGER forces persistent — the CH resume-freeze
    // that required autoStop=0 is FIXED (verified ~2.3s stop→resume), so it
    // idle-stops + CoW-resumes natively too.
  };

  // Detach the actual provisioning — the API caller navigates immediately
  // and the dashboard's ConnectingScreen handles the long tail.
  void runSessionSandboxProvisioning(
    {
      opts,
      sandbox,
      sessionToken,
      providerCreateInput,
      tl,
      llmGatewayEnabled,
      providerWasExplicitlySelected,
      resolveGitProject,
      resolveImage,
    },
    state,
  );

  return { row: sandbox, created: true };
}

/** Resolve (or build) the boot image for this attempt and record it on `state`. */
async function resolveAttemptImage(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  branch: string,
): Promise<EnsureSandboxImageResult> {
  const { sandbox, providerCreateInput, tl } = ctx;
  // Stateless image resolution: ask Daytona if it has the image; build if not.
  // No DB lookup, no degraded fallback — the snapshot is either there or we
  // build it inline. The build log captures the attempt for the dashboard;
  // it is never read on this path. The first attempt consumes the promise we
  // kicked off in parallel with the token round-trip; heal-retries re-resolve
  // from scratch (the prior snapshot was just deleted).
  let image: EnsureSandboxImageResult;
  if (state.firstImagePromise) {
    image = await state.firstImagePromise;
    state.firstImagePromise = null;
  } else {
    const gitProject = await ctx.resolveGitProject();
    image = await ctx.resolveImage(gitProject, state.providerName);
  }
  state.imageInfo = {
    snapshotName: image.snapshotName,
    slug: image.slug,
    contentHash: image.contentHash,
    isDefault: image.isDefault,
    runtimeProfile: image.runtimeProfile,
    spec: image.spec,
  };
  tl.mark(image.built ? 'image-built' : 'image-cached');
  providerCreateInput.snapshot = image.snapshotName;
  console.log(
    `[session-sandbox] Booting ${sandbox.sandboxId} from ${image.snapshotName} ` +
    `(template "${image.slug}"${image.isDefault ? ' [platform default]' : ''}, ` +
    `branch ${branch}, ${image.built ? 'fresh build' : 'cache hit'})`,
  );
  return image;
}

/**
 * Create the provider box: a parked pi worker claim, else the provider create
 * with its retries. Returns null when the attempt must restart the loop.
 */
async function createAttemptSandbox(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  image: EnsureSandboxImageResult,
  firstStage: ProvisioningStage,
): Promise<{ result: ProvisionResult; attempts: number } | null> {
  const { opts, sandbox, providerCreateInput, tl } = ctx;
  const { providerName, provider } = state;
  // FIX-A: honor the activated pinned template id (provider-matched) so the
  // running sandbox is the EXACT warm image activation chose — behind the
  // kill-switch, and only when the provider supports id-boot.
  const bootDecision = decideSessionBoot({
    killSwitchOn: sessionBootByTemplateIdEnabled(),
    routing: state.activeRouting,
    providerName,
    providerSupportsIdBoot: typeof provider.createFromExternalId === 'function',
    imageIsDefault: image.isDefault,
    imageSnapshotName: image.snapshotName,
    disabledForSession: state.idBootDisabled || opts.allowProjectImage === false,
  });
  if (bootDecision.bootByTemplateId) {
    console.log(
      `[session-sandbox] booting ${sandbox.sandboxId} by PINNED template id ` +
      `${bootDecision.bootByTemplateId} (provider ${providerName})`,
    );
  }
  const createFn = bootDecision.bootByTemplateId
    ? (o: CreateSandboxOpts) => provider.createFromExternalId!(bootDecision.bootByTemplateId!, o)
    : undefined;
  // No provider edge is armed at create: one mechanism serves daytona, e2b
  // and platinum alike. The guest holds a handle; the broker route substitutes server-side.
  let result: ProvisionResult;
  let attempts: number;
  try {
  ({ result, attempts } = await retrySandboxProvisionCreate(provider, providerCreateInput, {
    onAttemptStart: async (attempt, maxAttempts) => {
      state.lastProvisionAttempt = attempt;
      state.lastProvisionMaxAttempts = maxAttempts;
      const snapshot = sandbox.metadata as Record<string, unknown> | null;
      await db
        .update(sessionSandboxes)
        .set({
          metadata: patchedSandboxMetadata(
            sandboxInitMetadataPatch(snapshot, {
              ...buildSandboxInitAttemptMetadata(
                snapshot,
                attempt,
                attempt === 1 ? 'provisioning' : 'retrying',
                firstStage?.id,
                attempt === 1 ? firstStage?.message : `Retrying initialization (${attempt}/${maxAttempts})…`,
                maxAttempts,
              ),
              // S1: persist the MONOTONIC counter every attempt (cheap,
              // idempotent write of the current value) so a mid-attempt
              // process crash still leaves the latest value durable for
              // restorePlatinumCreateAttempt to pick up on resume.
              platinumCreateAttempt: state.platinumCreateAttempt,
            }),
          ),
          updatedAt: new Date(),
        })
        .where(eq(sessionSandboxes.sandboxId, sandbox.sandboxId));
    },
    onAttemptFailure: async (attempt, error, willRetry, maxAttempts) => {
      state.lastProvisionAttempt = attempt;
      state.lastProvisionMaxAttempts = maxAttempts;
      const snapshot = sandbox.metadata as Record<string, unknown> | null;
      await transitionSandbox(willRetry ? 'reprovision' : 'failProvisioning', sandbox.sandboxId, {
        metadata: sandboxInitMetadataPatch(
          snapshot,
          buildSandboxInitFailureMetadata(snapshot, error, attempt, willRetry, maxAttempts),
        ),
      });
    },
  }, createFn));
  } catch (createErr) {
    // FIX-A: a DEFINITIVE GC'd-pin 404 → fall back to a NAME boot for THIS
    // session (re-enter the loop with id-boot disabled). Do NOT self-repair
    // the pin here — that races the activation generation CAS; log it and let
    // the provider-transition controller re-pin. A transient 5xx (or any
    // other error) is re-thrown to the outer catch (failover/capacity/error)
    // and surfaced — never silently name-booted onto a possibly-wrong image.
    if (bootDecision.bootByTemplateId && createErr instanceof SandboxTemplateNotFoundError) {
      console.warn(
        `[session-sandbox] pinned template ${bootDecision.bootByTemplateId} for ${sandbox.sandboxId} ` +
        `is gone (404) — booting by name; leaving the pin for the controller to re-pin`,
      );
      state.idBootDisabled = true;
      // S1: a confirmed GC'd-pin 404 is a genuinely NEW attempt (a
      // different template id is about to be booted) — advance so the
      // next create gets a fresh Idempotency-Key/name instead of reusing
      // the pinned-template attempt's.
      state.platinumCreateAttempt += 1;
      providerCreateInput.createAttempt = state.platinumCreateAttempt;
      return null;
    }
    throw createErr;
  }
  return { result, attempts };
}

/**
 * The session was deleted or stopped while provider.create ran. Remove or stop
 * the new box and close the row. Returns true when provisioning ends here.
 */
async function settleSandboxStoppedDuringCreate(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  result: ProvisionResult,
  attempts: number,
  timeline: ProvisionTimelineSummary,
): Promise<boolean> {
  const { opts, sandbox, tl } = ctx;
  const { accountId } = opts;
  const { providerName, provider } = state;
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
    // 'archived', not 'stopped': the box is gone, so GET …/sandbox must
    // not try to resume it — it reprovisions fresh on reopen instead.
    await transitionSandbox('archive', sandbox.sandboxId, {
      columns: { externalId: result.externalId, baseUrl: result.baseUrl || null },
      metadata: {
        merge: {
          initStatus: 'failed',
          initAbortedAt: new Date().toISOString(),
          lastInitError: 'Session was stopped before provider create completed',
          provisionTimeline: timeline,
          providerExternalId: result.externalId,
        },
      },
    });
    tl.mark('row-stopped-before-active');
    tl.log({ provider: providerName, attempts, stoppedBeforeActive: true });
    const stopTl = tl.summary();
    recordProviderEvent({
      provider: providerName, kind: 'provision', outcome: 'stopped',
      totalMs: stopTl.totalMs, marks: stopTl.marks, attempts,
      sessionId: sandbox.sandboxId, accountId,
    });
    return true;
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
    const snapshot = sandbox.metadata as Record<string, unknown> | null;
    await transitionSandbox('stop', sandbox.sandboxId, {
      columns: { externalId: result.externalId, baseUrl: result.baseUrl || null },
      metadata: sandboxInitMetadataPatch(snapshot, {
        ...buildSandboxInitSuccessMetadata(
          snapshot,
          {
            ...result.metadata,
            provisionTimeline: timeline,
            providerExternalId: result.externalId,
          },
          attempts,
          state.lastProvisionMaxAttempts,
        ),
        stoppedDuringProvisioning: true,
        stoppedAt: new Date().toISOString(),
      }),
    });
    tl.mark('row-stopped-during-provision');
    tl.log({ provider: providerName, attempts, stoppedDuringProvisioning: true });
    const stoppedTl = tl.summary();
    recordProviderEvent({
      provider: providerName, kind: 'provision', outcome: 'stopped',
      totalMs: stoppedTl.totalMs, marks: stoppedTl.marks, attempts,
      sessionId: sandbox.sandboxId, accountId,
    });
    return true;
  }
  return false;
}

/** Run the pre-active hook, flip the row to `active`, and open compute metering. */
async function activateProvisionedSandbox(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  created: {
    result: ProvisionResult;
    attempts: number;
    timeline: ProvisionTimelineSummary;
    firstStage: ProvisioningStage;
    branch: string;
  },
): Promise<void> {
  const { opts, sandbox, sessionToken, tl, llmGatewayEnabled } = ctx;
  const { accountId, userId } = opts;
  const { providerName, provider } = state;
  const { result, attempts, timeline, firstStage, branch } = created;
  // Pre-active hook (legacy migration chat restore). Runs while the row is
  // still 'provisioning' so the frontend hasn't started ensure-opencode yet.
  //
  // The comment here used to say "never block the session opening on it" while
  // the code awaited it UNBOUNDED — and the telemetry shows what that cost
  // when the hook was live: `before-active-hook` p50 12 267ms, p90 33 762ms,
  // max 62 490ms across 162 provisions, every millisecond of it added to
  // time-to-usable because the row cannot flip to 'active' until this returns
  // (last live occurrence 2026-07-12; no caller passes `beforeActive` today,
  // so this is currently unreachable).
  //
  // Left in place as the documented extension point it is, but now bounded so
  // re-enabling it cannot silently reintroduce a 12-60s stall. On timeout the
  // hook keeps running detached — it is a data-restore, so abandoning the WAIT
  // is right while abandoning the WORK is not — and the session proceeds to
  // 'active' as the original comment always promised.
  if (opts.beforeActive) {
    try {
      await withTimeout(
        opts.beforeActive(result.externalId),
        BEFORE_ACTIVE_HOOK_TIMEOUT_MS,
        `beforeActive(${sandbox.sandboxId})`,
      );
      tl.mark('before-active-hook');
    } catch (err) {
      console.warn(`[session-sandbox] beforeActive hook failed or timed out for ${sandbox.sandboxId}:`, err);
      tl.mark('before-active-hook-abandoned');
    }
  }

  // Async providers leave the row at 'provisioning' so the dashboard
  // poller can flip it to 'active' once port 8000 is reachable. Sync
  // providers (none today) would be ready immediately on create.
  const snapshot = sandbox.metadata as Record<string, unknown> | null;
  const finishMetadata = buildSandboxInitSuccessMetadata(
      snapshot,
      {
        ...result.metadata,
        provisioningStage: firstStage?.id,
        provisionTimeline: timeline,
        providerExternalId: result.externalId,
        runtimeArtifact: {
          artifactType: providerName === 'daytona' ? 'daytona_snapshot' : `${providerName}_template`,
          providerArtifactRef: state.imageInfo!.snapshotName,
          contentHash: state.imageInfo!.contentHash,
          sandboxSlug: state.imageInfo!.slug,
          isPlatformDefault: state.imageInfo!.isDefault,
          runtimeProfile: state.imageInfo!.runtimeProfile ?? 'standard',
          branch,
          provider: providerName,
        },
      },
      attempts,
      state.lastProvisionMaxAttempts,
    );

  // Conditional finish: `deleteSession()` is the ONLY place that sets a
  // session_sandboxes row to 'archived', and it does so as soon as the
  // user deletes the session — even while this provisioning IIFE is still
  // in flight. Guard the write so a late-finishing provision can never
  // resurrect a tombstoned row. If no row comes back, the session was
  // deleted mid-provision: remove the box we just created and stop —
  // no 'running' flip, no compute metering.
  //
  // Every provider flips to 'active' here: the legacy provider
  // provisioning status does not gate this table, and the frontend's own
  // readiness poller validates port 8000. `activate` never leaves
  // `archived`.
  const finished = await transitionSandbox('activate', sandbox.sandboxId, {
    columns: {
      externalId: result.externalId,
      baseUrl: result.baseUrl || null,
      config: { serviceKey: sessionToken, llmGatewayEnabled },
      lastUsedAt: new Date(),
    },
    metadata: sandboxInitMetadataPatch(snapshot, finishMetadata),
  });

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
  await transitionSession('provisioned', sandbox.sandboxId, {
    sandboxUrl: result.baseUrl || null,
  }).catch((sessionErr) =>
    // No sweep repairs this: stuck-sessions skips a session whose sandbox
    // row is active. Log it so it is at least visible.
    logger.error(
      `[session-sandbox] ${sandbox.sandboxId} is active but its session row was not marked provisioned:`,
      { error: sessionErr instanceof Error ? sessionErr.message : String(sessionErr) },
    ),
  );

  tl.mark('row-active');
  // A first prompt waiting for this box re-opens the session now.
  signalSessionRuntimeActive(sandbox.sandboxId);
  tl.log({ provider: providerName, attempts });

  const okTl = tl.summary();
  recordProviderEvent({
    provider: providerName, kind: 'provision', outcome: 'ok',
    totalMs: okTl.totalMs, marks: okTl.marks, attempts,
    sessionId: sandbox.sandboxId, accountId,
  });

  // Billing v2 — open a compute metering row. No-op for legacy accounts.
  // Billed at the size of the image that booted (computeMeteringSpec).
  void openComputeSessionForSandbox(
    sandbox.sandboxId,
    accountId,
    opts.gitProject,
    userId,
    state.imageInfo?.slug,
    providerName,
    state.imageInfo?.spec,
  ).catch(
    (err) =>
      console.warn(
        `[session-sandbox] failed to open compute metering for ${sandbox.sandboxId}:`,
        err instanceof Error ? err.message : String(err),
      ),
  );
}

/**
 * One provisioning attempt: image, provider create, then activation. Returns
 * 'retry' when the loop must run again (a GC'd template pin fell back to name boot).
 */
async function runProvisionAttempt(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
): Promise<'done' | 'retry'> {
  const { opts, sandbox, tl } = ctx;
  const branch = opts.baseRef || opts.gitProject.defaultBranch;
  // Resolved for its VALIDATION only: it re-reads the agent grant and
  // throws on a policy no session could serve, which is what turns a broken
  // secret config into `invalid-secret-boundary-policy` instead of a
  // generic provider fault. There is nothing to register with a provider —
  // one mechanism serves daytona, e2b and platinum alike: the guest gets a HANDLE
  // and the broker route substitutes the real value server-side.
  await resolveSessionNetworkBoundary(opts.projectId, sandbox.sandboxId);
  tl.note('network-boundary');

  const image = await resolveAttemptImage(ctx, state, branch);

  const firstStage = state.provider.provisioning.stages[0];
  const created = await createAttemptSandbox(ctx, state, image, firstStage);
  if (!created) return 'retry';
  const { result, attempts } = created;
  state.bgExternalId = result.externalId;
  tl.mark(`provider-create:${attempts}x`);
  const timeline = tl.summary();

  if (await settleSandboxStoppedDuringCreate(ctx, state, result, attempts, timeline)) return 'done';
  await activateProvisionedSandbox(ctx, state, { result, attempts, timeline, firstStage, branch });
  return 'done';
}

/**
 * The provider dropped the image between resolve and create: rebuild it and
 * retry once. Returns true when the loop must run again.
 */
async function healMissingSnapshot(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  bgErr: unknown,
): Promise<boolean> {
  const { opts, sandbox, providerCreateInput } = ctx;
  // The selected provider dropped the image between resolve and create. Force a rebuild
  // (delete the snapshot so the next ensureSandboxImage call rebuilds it)
  // and retry once. Capped at one heal per session start.
  if (isSnapshotMissingOnProvider(bgErr) && state.imageInfo && !state.healedStaleSnapshot) {
    state.healedStaleSnapshot = true;
    await deleteSandboxImage(opts.gitProject, {
      slug: state.imageInfo.slug,
      provider: state.providerName,
    }).catch((err: unknown) =>
      console.warn(
        `[session-sandbox] force-rebuild failed for ${state.imageInfo!.snapshotName}:`,
        err,
      ),
    );
    console.warn(
      `[session-sandbox] healing missing image ${state.imageInfo.snapshotName} for ${sandbox.sandboxId} — retrying`,
    );
    if (state.bgExternalId) {
      await state.provider.remove(state.bgExternalId).catch((cleanupErr) =>
        console.warn(`[session-sandbox] post-heal cleanup of ${state.bgExternalId} failed:`, cleanupErr),
      );
      state.bgExternalId = null;
    }
    state.imageInfo = null;
    // S1: the old box (if any) was just removed above and we're about to
    // build/boot a genuinely fresh image — advance so the retry mints a
    // fresh Idempotency-Key/name rather than reusing the healed attempt's.
    state.platinumCreateAttempt += 1;
    providerCreateInput.createAttempt = state.platinumCreateAttempt;
    return true;
  }
  return false;
}

/**
 * Provider failover (one-shot, on init). Returns true when the row now names
 * the next provider and the loop must run again on it.
 */
async function failOverToNextProvider(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  bgMessage: string,
): Promise<boolean> {
  const { opts, sandbox, providerCreateInput, tl, providerWasExplicitlySelected } = ctx;
  const { accountId } = opts;
  const { providerName, provider } = state;
  // ── Provider failover (one-shot, on init) ────────────────────────────
  // Admin-gated (DB `provider_fallback`, OFF by default). When ON, a
  // provider that fails to provision the session AT BIRTH hands off ONCE to
  // the next allowed provider before the session is marked failed. Init
  // only — a running box is never migrated here. The new provider re-resolves
  // its own image (the snapshot is provider-specific), so we clear all image
  // state and re-enter the loop.
  const next = nextFailoverProvider({
    providerLocked: providerWasExplicitlySelected,
    fallbackAttempted: state.fallbackAttempted,
    fallbackEnabled: providerFallbackSetting().enabled,
    current: providerName,
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
  }) as ProviderName | null;
  let switched = false;
  if (next) {
    state.fallbackAttempted = true;
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
    if (state.bgExternalId) {
      const failedBox = state.bgExternalId;
      await provider.remove(failedBox).catch((removeErr) =>
        logger.error(
          `[session-sandbox] failover could not remove ${providerName} box ${failedBox} for ${sandbox.sandboxId}; the orphan sweep stops it:`,
          { error: removeErr instanceof Error ? removeErr.message : String(removeErr) },
        ),
      );
      state.bgExternalId = null;
    }
    // The row must name the new provider BEFORE its box exists: a box
    // on `next` under a row that still says `providerName` is unknown to
    // the orphan sweep, which stops it. If the switch does not land,
    // fail this session instead of failing over.
    switched = await transitionSandbox('reprovision', sandbox.sandboxId, {
      columns: { provider: next },
    }).then(
      () => true,
      (switchErr) => {
        logger.error(
          `[session-sandbox] failover to ${next} aborted for ${sandbox.sandboxId}: the provider switch was not written:`,
          { error: switchErr instanceof Error ? switchErr.message : String(switchErr) },
        );
        return false;
      },
    );
  }
  if (next && switched) {
    state.providerName = next;
    state.provider = getProvider(next);
    providerCreateInput.snapshot = undefined;
    state.firstImagePromise = null;
    state.imageInfo = null;
    state.healedStaleSnapshot = false;
    // S1: a genuinely new attempt — a DIFFERENT provider is about to
    // create an unrelated box, so reusing the failed provider's
    // Idempotency-Key/name here would be meaningless (Platinum is the
    // only provider that reads it today, but this keeps the counter
    // correct if `next` is Platinum).
    state.platinumCreateAttempt += 1;
    providerCreateInput.createAttempt = state.platinumCreateAttempt;
    tl.mark(`failover:${next}`);
    return true;
  }
  return false;
}

/** Final failure: clean up the box, fail the row and the session, tell the channel. */
async function failSessionSandboxProvisioning(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
  bgErr: unknown,
  bgMessage: string,
): Promise<void> {
  const { opts, sandbox, tl } = ctx;
  const { accountId } = opts;
  const { providerName, provider, bgExternalId } = state;
  // Keep provider SDK text in diagnostic metadata. Show one stable contract
  // for E2B, Daytona, Platinum, and future providers.
  const failure = classifySandboxProvisioningFailure(bgErr);
  const { isCapacity, isGitAuth, userMessage } = failure;
  const failureCategory = failure.category;
  if (isCapacity) {
    console.warn(
      `[session-sandbox] provider at capacity for ${sandbox.sandboxId} — stopping automatic provisioning:`,
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
    const snapshot = sandbox.metadata as Record<string, unknown> | null;
    await transitionSandbox('failProvisioning', sandbox.sandboxId, {
      metadata: sandboxInitMetadataPatch(snapshot, {
        ...buildSandboxInitFailureMetadata(
          snapshot,
          bgErr,
          state.lastProvisionAttempt,
          false,
          state.lastProvisionMaxAttempts,
        ),
        errorMessage: userMessage,
        lastProvisioningError: bgMessage.slice(0, 500),
        ...(failureCategory ? { failureCategory } : {}),
      }),
    });
    await transitionSession('fail', sandbox.sandboxId, { error: userMessage }).catch((sessionErr) =>
      logger.error(
        `[session-sandbox] ${sandbox.sandboxId} failed but its session row was not marked failed (stuck-sessions stops it after its TTL):`,
        { error: sessionErr instanceof Error ? sessionErr.message : String(sessionErr) },
      ),
    );
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
}

/**
 * The detached provider create behind provisionSessionSandbox(). Retries,
 * heals and fails over inside one loop; every failure ends on the row.
 */
async function runSessionSandboxProvisioning(
  ctx: SessionProvisionContext,
  state: SessionProvisionState,
): Promise<void> {
  const { opts, sandbox, providerCreateInput } = ctx;
  const { projectId } = opts;
  // FIX-A: the project's ACTIVATED routing pin (provider + exact template id
  // and image name), read once, best-effort — a DB hiccup yields null → name-boot. Set
  // `idBootDisabled` once a definitive GC'd-pin 404 forces this session down to
  // a name-boot, so the retry never re-attempts the dead pin.
  try {
    state.activeRouting = await readActiveRouting(db, projectId);
  } catch (routingErr) {
    console.warn(
      `[session-sandbox] readActiveRouting failed for ${projectId} (falling back to name-boot):`,
      routingErr instanceof Error ? routingErr.message : String(routingErr),
    );
  }
  // S1: MONOTONIC Platinum create-attempt counter — restored from the row's
  // persisted metadata (never resets across a process restart) and set on
  // providerCreateInput ONCE up front. It only advances at the three
  // "genuinely new attempt" transitions below (stale-snapshot heal,
  // provider failover, id-boot-pin-gone fallback) — retrySandboxProvisionCreate's
  // own internal retry-on-transient-error loop reuses createOpts unchanged,
  // so it reuses this SAME attempt (and therefore the SAME Platinum
  // Idempotency-Key/name) across those "ambiguous retry" iterations.
  state.platinumCreateAttempt = restorePlatinumCreateAttempt(sandbox.metadata as Record<string, unknown> | null) || 1;
  providerCreateInput.createAttempt = state.platinumCreateAttempt;
  provisioning: while (true) {
    try {
      if ((await runProvisionAttempt(ctx, state)) === 'retry') continue provisioning;
      break provisioning;
    } catch (bgErr) {
      if (await healMissingSnapshot(ctx, state, bgErr)) continue provisioning;

      const bgMessage = bgErr instanceof Error ? bgErr.message : String(bgErr);

      if (await failOverToNextProvider(ctx, state, bgMessage)) continue provisioning;

      await failSessionSandboxProvisioning(ctx, state, bgErr, bgMessage);
      break provisioning;
    }
  }
}
