import { config } from '../../config';
import { DaytonaProvider } from './daytona';
import { E2BProvider } from './e2b';
import { PlatinumProvider } from './platinum';
import { LocalDockerProvider } from './local-docker';

/**
 * Sandbox provider lineup. Extensible registry — adding a new runtime is
 * a one-place change in `getProvider()` plus a value added to the
 * `ProviderName` union. Call sites depend on the `SandboxProvider`
 * interface, not the concrete class, so they stay untouched.
 *
 *   - daytona — Daytona Cloud
 *   - platinum — Kortix Platinum
 *   - e2b — E2B Cloud
 *   - local-docker — EXPERIMENTAL. Same-machine Docker containers (see
 *     local-docker.ts) — no cloud account, not horizontally scalable.
 */
export type ProviderName = 'daytona' | 'platinum' | 'e2b' | 'local-docker';

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
}

export interface ProvisionResult {
  externalId: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
}

export type SandboxStatus = 'running' | 'stopped' | 'removed' | 'unknown';
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

export interface SandboxProvider {
  readonly name: ProviderName;
  readonly provisioning: ProvisioningTraits;
  /**
   * Whether this provider's sandboxes reach kortix-api over the PUBLIC
   * internet. True for every remote cloud provider (Daytona/Platinum/E2B) —
   * their sandbox VMs/containers run on infrastructure that can only resolve
   * a publicly reachable KORTIX_URL, never a loopback address. False for a
   * same-machine provider (local-docker) whose sandboxes reach kortix-api
   * over the shared Docker network instead, so a loopback KORTIX_URL is
   * perfectly fine there. Session creation's reachability preflight
   * (sandboxCallbackUnreachableReason in projects/lib/sessions.ts) is the
   * ONLY reader of this flag — keeping the capability on the provider
   * instead of a call-site `provider === 'local-docker'` check.
   */
  readonly requiresPublicCallback: boolean;

  create(opts: CreateSandboxOpts): Promise<ProvisionResult>;
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
 * Provider-native auto-stop is a BACKSTOP, not the primary stop mechanism.
 * The reaper (projects/sandbox-reaper.ts) is the primary: it asks the box's
 * own opencode whether a turn is running before stopping, so it never kills
 * mid-work. The provider's native timer only sees inbound traffic — blind to
 * local tool runs — so at the reaper's TTL it WOULD kill working boxes (the
 * 2026-06-24 "stopped too quickly mid-session" class). Its sole job is to
 * stop boxes when this API is dead or the box has no DB row, so it sits well
 * above the reaper's window.
 */
export function providerAutoStopBackstopMinutes(): number {
  const ttl = Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || 15);
  return Math.max(60, ttl * 2);
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
    case 'local-docker':
      // No required API key — Docker daemon reachability is checked lazily at
      // first real use (create/start/stop/status), not at construction, so
      // the API can still boot before Docker is wired up. See local-docker.ts.
      provider = new LocalDockerProvider();
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown sandbox provider: ${exhaustive}`);
    }
  }

  providers.set(name, provider);
  return provider;
}
