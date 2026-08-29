import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { E2BProvider } from './e2b';
import { PlatinumProvider } from './platinum';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona — Daytona Cloud
 *   - platinum — Kortix Platinum
 *   - e2b — E2B Cloud
 */
export type ProviderName = 'daytona' | 'platinum' | 'e2b';

/**
 * Thrown by the Daytona warm path when the experimental memory-snapshot restore
 * comes up WITHOUT the baked runtime (its filesystem layer is dropped ~half the
 * time — a Daytona experimental-region bug). Non-retryable at the provision
 * layer: the caller falls back to the normal Dockerfile-snapshot path instead of
 * creating more flaky memory-snapshot restores.
 */
export class WarmRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarmRuntimeUnavailableError';
  }
}

/**
 * Thrown by a runtime provider's {@link SandboxProvider.createFromExternalId} when
 * the pinned template id is DEFINITIVELY gone (a 404 — the template was
 * garbage-collected). FIX-A: this is the ONLY signal the boot path treats as
 * license to fall back to a name-boot. A transient 5xx throws a normal
 * (retryable) error instead, so a provider outage never silently boots a
 * possibly-wrong template under a different (name) resolution while masking the
 * outage. Non-retryable at the provision-retry layer (fail fast → name fallback).
 */
export class SandboxTemplateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxTemplateNotFoundError';
  }
}

/**
 * Which runtime contract a provider object hosts. One name per workload, used
 * verbatim as `sandbox_compute_sessions.workload_type`, so the union and that
 * column's CHECK constraint must stay in lockstep.
 */
export type SandboxWorkloadType = 'session' | 'app' | 'monitor';

export interface CreateSandboxOpts {
  accountId: string;
  userId: string;
  name: string;
  envVars?: Record<string, string>;
  serverType?: string;
  location?: string;
  /**
   * Override the provider's default snapshot/image with one built
   * specifically for this project. The snapshot builder
   * (apps/api/src/snapshots/builder.ts) populates this when a session
   * boots; falls back to the provider-wide default when absent.
   */
  snapshot?: string;
  /**
   * Provider auto-stop idle timeout in minutes. Defaults to the provider's own
   * value (15). Providers clamp session sandboxes so normal runtime creation
   * cannot create persistent boxes.
   */
  autoStopInterval?: number;
  /**
   * S1 (idempotent create): the FULL logical `session_sandboxes.sandboxId` —
   * a 36-char UUID — that this create() call is provisioning for. NEVER pass
   * the truncated `name` field (session-sandbox.ts derives it as
   * `session-<sandboxId.slice(0, 8)>`, which collides far more often than the
   * full UUID and is not a safe create-dedup key). OPTIONAL: only a provider
   * that implements create-side idempotency reads it (Platinum today — see
   * platinum.ts's deterministic Idempotency-Key + name); every other
   * provider/test can omit it and gets today's unchanged behavior.
   */
  sandboxId?: string;
  /**
   * S1: a MONOTONIC per-sandbox create-attempt counter, persisted by
   * session-sandbox.ts in `session_sandboxes.metadata.platinumCreateAttempt`
   * and restored on resume so it NEVER resets across a process restart, a
   * heal-retry, or a provider failover (a reset would replay a stale
   * attempt's deterministic name/Idempotency-Key and could wrongly adopt an
   * abandoned box). A provider that derives a create-dedup identity from
   * (sandboxId, attempt) should keep that identity STABLE across retries of
   * the SAME attempt and only mint a new one when `attempt` advances.
   * OPTIONAL, same rationale as `sandboxId` above.
   */
  createAttempt?: number;
  /**
   * Runtime contract hosted by the provider object. Missing means `session`
   * for backward compatibility with every existing caller.
   *
   * `monitor` is the per-project monitor box (docs/specs/2026-08-12-monitors.md
   * D3): the SAME image and the SAME agent port as a session, running the
   * daemon in monitor mode instead of opencode. It differs from a session only
   * in lifecycle (`autoStopInterval: 0` → persistent) and in having no
   * `session_sandboxes` row.
   */
  workloadType?: SandboxWorkloadType;
  /** Provider-normalized App machine limits. Session snapshots retain their existing limits. */
  resourceSpec?: {
    cpuCores: number;
    memoryGb: number;
    diskGb: number;
  };
  /** Ports that the provider must make reachable through resolveIngress(). */
  publishedPorts?: number[];
}

export function sandboxWorkloadType(opts: CreateSandboxOpts): SandboxWorkloadType {
  return opts.workloadType ?? 'session';
}

export function assertWorkloadCredential(
  provider: ProviderName,
  opts: CreateSandboxOpts,
  envVars: Record<string, string>,
): void {
  const workloadType = sandboxWorkloadType(opts);
  // A monitor box runs the SAME daemon a session runs, so it carries the SAME
  // sandbox credential — the ingest route is a sandbox-token route. Only the
  // App runtime speaks the appd control protocol and needs the appd token.
  const required = workloadType === 'app' ? 'KORTIX_APPD_TOKEN' : 'KORTIX_TOKEN';
  if (!envVars[required]) {
    throw new Error(
      `[${provider}] create() called without ${required} for ${workloadType} workload`,
    );
  }
}

export interface ProvisionResult {
  externalId: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
}

export type { SandboxStatus } from './status';
import type { SandboxStatus } from './status';
export type InPlaceRecoveryStatus = 'running' | 'recovering' | 'unavailable';

export interface ResolvedEndpoint {
  url: string;
  headers: Record<string, string>;
}

export interface SandboxIngressRequest {
  /** Port named by the caller-facing Kortix proxy URL. */
  port: number;
  path?: string;
  transport?: 'http' | 'websocket';
}

/**
 * Provider-normalized sandbox ingress. Provider-specific edge auth, port
 * bridging, and WebSocket query behavior live here so the proxy never branches
 * on a provider name.
 */
export interface ResolvedSandboxIngress {
  url: string;
  headers: Record<string, string>;
  effectivePort: number;
  websocket?: {
    userContextQueryParam?: string;
    queryDefaults?: Record<string, string>;
  };
}

export type SandboxIngressRoute = Pick<ResolvedSandboxIngress, 'effectivePort' | 'websocket'>;

interface ProvisioningStage {
  id: string;
  progress: number;
  message: string;
}

export interface ProvisioningTraits {
  async: boolean;
  stages: ProvisioningStage[];
}

export interface ProvisioningStatus {
  stage: string;
  progress: number;
  message: string;
  complete: boolean;
  error: boolean;
  errorMessage?: string;
}

/**
 * Which dimensions of an App machine specification a provider can actually
 * enforce. Kortix bills an App from the specification it recorded, so a
 * dimension the provider cannot honor must not reach the meter: E2B's
 * Template.build accepts cpuCount and memoryMB and has no disk parameter
 * (e2b 2.37.0), so an App on E2B was being charged for disk nobody allocated.
 */
export interface AppMachineSupport {
  cpu: boolean;
  memoryGb: boolean;
  diskGb: boolean;
}

export const FULL_APP_MACHINE_SUPPORT: AppMachineSupport = {
  cpu: true,
  memoryGb: true,
  diskGb: true,
};

export interface AppMachine {
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
}

/**
 * The machine a provider will really allocate, which is what billing must use.
 * A dimension the provider cannot set bills as zero rather than as the number
 * the customer typed. Absent support means the provider honors everything.
 */
export function effectiveAppMachine(
  provider: { appMachineSupport?: AppMachineSupport },
  requested: AppMachine,
): AppMachine {
  const support = provider.appMachineSupport ?? FULL_APP_MACHINE_SUPPORT;
  return {
    cpuCores: support.cpu ? requested.cpuCores : 0,
    memoryGb: support.memoryGb ? requested.memoryGb : 0,
    diskGb: support.diskGb ? requested.diskGb : 0,
  };
}

export interface SandboxProvider {
  readonly name: ProviderName;
  readonly provisioning: ProvisioningTraits;
  /**
   * How long the shared proxy may cache one resolved ingress. Omit for the
   * default cache. Use zero when the provider owns a shorter credential cache.
   */
  readonly ingressCacheTtlMs?: number;
  /** Absent means the provider enforces the whole App machine specification. */
  readonly appMachineSupport?: AppMachineSupport;
  create(opts: CreateSandboxOpts): Promise<ProvisionResult>;
  /**
   * Ensure the Kortix App supervisor is running after create or resume.
   * Providers that honor the image ENTRYPOINT implement this as a no-op.
   * Providers that replace ENTRYPOINT must start `/kortix/bin/kortix-appd`
   * through their native process API. The operation must be idempotent.
   */
  ensureAppRuntimeStarted(externalId: string): Promise<void>;
  /**
   * Ensure the SESSION runtime process is running in an already-running box.
   *
   * The same problem `ensureAppRuntimeStarted` solves for appd, for the other
   * workload. A provider that replaces the image ENTRYPOINT resumes the box
   * with NOTHING running inside it, so a stopped session never comes back:
   * measured on pi.kortix.com 2026-08-29, a stopped pi-worker session failed
   * every resume with `runtime_unreachable_timeout` while never-stopped boxes
   * on the SAME snapshot stayed ready.
   *
   * `shared.ts` calls this at the 30s unreachable stall — the point its own
   * comment says "needs an explicit restart" — BEFORE cycling the box, because
   * cycling cannot help when the box is fine and only the process is missing.
   *
   * OPTIONAL: a provider that re-runs its entrypoint on resume (Platinum
   * cold-boots the template) needs no implementation. Must be idempotent and
   * safe to call on a healthy box.
   */
  ensureSessionRuntimeStarted?(externalId: string): Promise<void>;
  /**
   * FIX-A: boot a sandbox from an EXACT provider template id (not a name). The
   * boot path uses this to honor a project's activated
   * `active_sandbox_external_template_id` pin, so the running sandbox is the
   * precise warm image activation chose — the name path can drift behind a
   * truncated template list or an idempotent-adopt that reused a name. OPTIONAL:
   * only providers with a durable external template id implement it (Platinum;
   * Daytona and E2B keep the name-only default). On a DEFINITIVE
   * not-found (404 = GC'd pin) it MUST throw {@link SandboxTemplateNotFoundError}
   * so the caller can fall back to a name-boot; a transient 5xx throws a normal
   * (retryable) error and MUST NOT be turned into a name fallback.
   */
  createFromExternalId?(
    externalTemplateId: string,
    opts: CreateSandboxOpts,
  ): Promise<ProvisionResult>;
  start(externalId: string): Promise<void>;
  /**
   * Renew the provider-native lifecycle deadline for a sandbox that Kortix has
   * already confirmed is running and whose `session_sandboxes.deadline_at` is
   * still live.
   *
   * This operation is mandatory for every provider. It must be idempotent,
   * bounded, and must not wake a stopped sandbox. The provider implementation
   * owns its native mechanism: absolute timeout renewal, idle-timer activity,
   * or an equivalent control-plane operation. Only the Kortix reaper calls it;
   * an in-sandbox process cannot renew its own lifecycle.
   */
  renewLifecycle(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  remove(externalId: string): Promise<void>;
  getStatus(externalId: string): Promise<SandboxStatus>;
  /**
   * Recover the SAME provider object when provider state looks terminal.
   * Implementations may restore a provider-native disk backup, but must never
   * create or return a different external identity. Callers fail closed when
   * this capability is absent or returns unavailable.
   */
  recoverInPlace?(externalId: string): Promise<InPlaceRecoveryStatus>;
  resolveEndpoint(externalId: string): Promise<ResolvedEndpoint>;
  routeIngress(request: SandboxIngressRequest): SandboxIngressRoute;
  /**
   * Resolve a reachable upstream URL for an arbitrary port — the data path the
   * `/v1/p/<externalId>/<port>` reverse proxy forwards to. Unlike resolveEndpoint
   * (fixed at the agent port), this takes any port so user preview apps work too.
   * EVERY provider must implement it: the proxy used to hardcode Daytona, which
   * silently broke every other provider's runtime connection (502/503). Keeping
   * it on the interface makes that regression a compile error.
   */
  resolveIngress(
    externalId: string,
    request: SandboxIngressRequest,
  ): Promise<ResolvedSandboxIngress>;
  ensureRunning(externalId: string): Promise<void>;
  getProvisioningStatus(sandboxId: string): Promise<ProvisioningStatus | null>;
  /**
   * List the running boxes this deployment owns, for the orphan-box reaper
   * (boxes still running on the provider with no live DB row). OPTIONAL: a
   * provider that can't enumerate simply omits it and the reaper skips that
   * provider. Implementations MUST scope the result to THIS environment
   * (the provider org may be shared across prod/dev/local) and return
   * `createdAt` so the reaper can age-gate.
   */
  listManagedRunningSandboxes?(): Promise<Array<{ externalId: string; createdAt: Date | null }>>;
}

/**
 * PROVIDER-SAFETY POLICY. Nothing to do with billing — see the sibling constant
 * `billingLivenessGraceMinutes()` in billing/services/compute-liveness.ts, which
 * this function used to double as and must never be re-welded to. One number was
 * answering two unrelated questions:
 *
 *   billing grace     "how long after the last CONTROL-PLANE observation may we
 *                      still charge?" — a money guarantee, must stay TIGHT.
 *   provider backstop "how long may the PROVIDER let an unreachable box run
 *                      before killing it itself?" — a safety net, must stay
 *                      LOOSE or it kills working boxes.
 *
 * Tightening one used to loosen the other, so neither could be tuned.
 *
 * This is a BACKSTOP, not the primary stop mechanism. `deadline_at`
 * (projects/sandbox-deadline.ts) is primary: the reaper stops any active box
 * past its deadline, extended only by control-plane observations and the
 * durable active-turn record created by an accepted prompt. The
 * provider's native timer only sees INBOUND traffic — blind to local tool runs,
 * and no longer reset by an in-box keep-alive now that the execution lease is
 * deleted — so at the reaper's TTL it WOULD kill working boxes (the 2026-06-24
 * "stopped too quickly mid-session" class). Its sole job is to stop boxes when
 * this API is dead or the box has no DB row.
 *
 * WHY 12h. It must exceed the longest plausible stretch of a real run with zero
 * inbound requests, which is a whole turn spent in local tools. Measured on 30
 * days of prod: the p99 turn is ~78 min and the MAX is ~8.4h, and the p99.9 gap
 * between consecutive usage_events is already ~1h (long local tool runs emit
 * none at all). 12h is ~1.4x the worst turn ever observed and ~12x that p99.9
 * gap, so it cannot plausibly pre-empt a working box. The reaper resets this
 * provider timer while exact active-turn evidence remains live. When the API is
 * dead, an orphan bleeds at most 12 box-hours instead of the 264h measured on
 * 2026-07-29.
 *
 * FLOOR 60. Never below the value this function returned before the split, so a
 * mis-set env var cannot resurrect the mid-work-kill class. Callers needing a
 * deliberately short timer pass an explicit override instead (the trigger path
 * does: KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES). The floor is also what makes
 * the required ordering `billingLivenessGraceMinutes() <= this` structural
 * rather than coincidental — the billing grace floors at the same 60 and only
 * leaves that floor above a 30-minute idle window, which no environment sets.
 * Asserted in ./autostop-backstop.test.ts; lowering this default below the
 * billing grace fails CI there.
 */
export function providerAutoStopBackstopMinutes(): number {
  return Math.max(60, config.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES || 720);
}

const providers = new Map<ProviderName, SandboxProvider>();

export function getProvider(name: ProviderName): SandboxProvider {
  const existing = providers.get(name);
  if (existing) return existing;

  let provider: SandboxProvider;

  switch (name) {
    case 'daytona':
      if (!config.DAYTONA_API_KEY) {
        throw new Error('Daytona provider requires DAYTONA_API_KEY to be set.');
      }
      provider = new DaytonaProvider();
      break;
    case 'platinum':
      if (!config.PLATINUM_API_KEY) {
        throw new Error('Platinum provider requires PLATINUM_API_KEY to be set.');
      }
      provider = new PlatinumProvider();
      break;
    case 'e2b':
      if (!config.E2B_API_KEY) {
        throw new Error('E2B provider requires E2B_API_KEY to be set.');
      }
      provider = new E2BProvider();
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox provider: ${exhaustive}`);
    }
  }

  providers.set(name, provider);
  return provider;
}

/**
 * Best-effort provider resolution for teardown paths. Returns null instead of
 * throwing when the provider cannot be constructed — its API key is unset
 * (the provider is disabled on this deployment) or the name is not a known
 * provider (a legacy runtime deployed on a provider this box has since retired).
 *
 * Teardown code (App delete, stop, idle-reap, deploy supersede) must never fail
 * because a long-gone sandbox lived on a provider we can no longer reach: the
 * remote box is unreachable regardless, so the caller skips the remote call and
 * still completes the local state change (soft-delete, mark stopped, pause the
 * compute session). A live request path that genuinely needs the provider keeps
 * calling getProvider() and still gets the hard error.
 */
export function tryGetProvider(name: string): SandboxProvider | null {
  try {
    return getProvider(name as ProviderName);
  } catch {
    return null;
  }
}
