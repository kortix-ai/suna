import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { E2BProvider } from './e2b';
import { PlatinumProvider } from './platinum';
import type { NetworkBoundarySecretBinding } from '../../secrets/network-boundary';

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

const NETWORK_BOUNDARY_SYNC_MODE: Record<ProviderName, 'on-demand' | 'authoritative'> = {
  daytona: 'on-demand',
  platinum: 'authoritative',
  e2b: 'on-demand',
};

export function shouldSyncProviderNetworkBoundary(
  name: ProviderName,
  bindingCount: number,
): boolean {
  return bindingCount > 0 || NETWORK_BOUNDARY_SYNC_MODE[name] === 'authoritative';
}

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
  const required = workloadType === 'app' ? 'KORTIX_APPD_TOKEN' : 'KORTIX_SANDBOX_TOKEN';
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
  createFromExternalId?(externalTemplateId: string, opts: CreateSandboxOpts): Promise<ProvisionResult>;
  start(externalId: string): Promise<void>;
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
  resolveIngress(externalId: string, request: SandboxIngressRequest): Promise<ResolvedSandboxIngress>;
  ensureRunning(externalId: string): Promise<void>;
  getProvisioningStatus(sandboxId: string): Promise<ProvisioningStatus | null>;
  /** Apply the exact server-owned network credentials for one sandbox. */
  syncNetworkBoundary?(
    externalId: string,
    bindings: NetworkBoundarySecretBinding[],
  ): Promise<{ state: 'armed'; attached: number }>;
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
 * past its deadline, extended only by control-plane-observed turn starts. The
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
 * gap, so it cannot plausibly pre-empt a working box; it is 3x the 4h turn grant
 * and below ABSOLUTE_RUN_CAP_MS (24h), so while the API is alive the
 * activity-aware deadline always fires first, and when the API is dead an orphan
 * bleeds at most 12 box-hours instead of the 264h measured on 2026-07-29.
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
