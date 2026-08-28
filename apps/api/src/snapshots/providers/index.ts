/**
 * Sandbox provider adapters.
 *
 * A provider builds and hosts the actual sandbox image. Daytona, Platinum, and
 * E2B implement the `SandboxProviderAdapter` interface and slot in here.
 *
 * The provider is identified by a stable string (`daytona`, `platinum`, or
 * `e2b`) that lives on the template row. The session boot path resolves the
 * adapter by that string and delegates the actual snapshot build / state check.
 */

import { daytonaProvider } from './daytona';
import { e2bProvider } from './e2b';
import { platinumProvider } from './platinum';

interface SandboxResourceSpec {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}

export interface AppBuildContext {
  /** Validated and extracted App source. Absent for an OCI base image. */
  sourceDir?: string;
  /** Normalized non-secret specification baked into the deployment image. */
  runtimeSpec: Record<string, unknown>;
}

export interface BuildableTemplate {
  /** Snapshot name the provider should write under. */
  snapshotName: string;
  /** Exactly one of `image` or `userDockerfile` is set. */
  image?: string;
  userDockerfile?: string;
  /** Optional entrypoint override; null means use the provider default. */
  entrypoint?: string[];
  /** Resource spec. */
  spec: SandboxResourceSpec;
  /** Telemetry: caller-facing slug for logs. */
  slug: string;
  /** Shared platform default (vs per-project). Every template is built cold. */
  isShared?: boolean;
  /** Selects a fixed platform runtime instead of the full standard layer. */
  runtimeProfile?: 'standard' | 'fast' | 'meta' | 'app' | 'pi-worker';
  /** Required when runtimeProfile is app. */
  appContext?: AppBuildContext;
}

export type ProviderState =
  | 'active'
  | 'building'
  | 'build_failed'
  | 'removing'
  | 'unknown'
  | 'missing';

export { normalizeExistingProviderState } from './state';

export interface BuildLogTap {
  /** Streamed per line from the provider build. */
  onLine?: (line: string) => void;
  /**
   * Optional lease-renewal hook, called on every poll iteration of the
   * provider's `waitForActive` loop. Lets a caller (the provider-transition
   * drive) keep its lease alive during a long build so the TTL never lapses
   * mid-build. Resolves while still owned; THROWS to stop the wait when the
   * caller has lost ownership (a newer owner re-acquired). A transient error is
   * the callback's own to swallow — it must not throw on a mere DB blip.
   */
  heartbeat?: () => void | Promise<void>;
}

/**
 * The exact provider-side identity a build produced. Threaded from the build
 * call straight to the transition / per-project-warm path so the runner can pin
 * the id the build PROVED (Platinum's `requireExternalTemplateId` — the id
 * already in hand at registration) instead of re-deriving it via a fragile,
 * truncation-prone name-list lookup. `externalTemplateId` is absent on providers
 * with no external-id concept (Daytona and E2B return void).
 */
export interface BuildSnapshotResult {
  externalTemplateId?: string;
}

export interface SandboxProviderAdapter {
  readonly id: string;

  /**
   * Build the snapshot. The caller has already composed the layered Dockerfile
   * (user Dockerfile + Kortix runtime). Returns when the snapshot is `active`,
   * throws on terminal failure. May return the exact external template id the
   * build produced (Platinum); providers with no external-id concept return void.
   */
  buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult | void>;

  /** Query the live provider state. Returns 'missing' if not found. */
  getSnapshotState(snapshotName: string): Promise<ProviderState>;

  /**
   * Optional batch lookup for ordered snapshot candidates. Returns the first
   * active name in caller order, or null when none is active.
   */
  findFirstActiveSnapshot?(names: readonly string[]): Promise<string | null>;

  /**
   * Optional: prepare an already-active snapshot for the provider's fastest
   * launch path. Providers without a separate preparation phase omit it.
   * Implementations may throw; reuse callers must preserve the usable snapshot.
   */
  prepareSnapshot?(snapshotName: string): Promise<void>;

  /** Delete the snapshot (no-op if missing). */
  deleteSnapshot(snapshotName: string): Promise<void>;
  /** List provider snapshots/templates owned by the current account. */
  listSnapshots(): Promise<Array<{ name: string }>>;

  /**
   * Optional: resolve the provider-side EXTERNAL template/build id for an
   * already-registered snapshot name — persisted on a durable provider-migration
   * transition so it is tracked by the exact id the provider returned, not a
   * truncated name listing (see provider-transitions). Returns null when the
   * provider exposes no such id, the snapshot isn't registered yet, or on any
   * lookup error; callers treat null as "no id yet", never a hard failure.
   * Absent on providers with no external template id concept.
   */
  getSnapshotExternalId?(snapshotName: string): Promise<string | null>;

  /**
   * Optional (PHASE 2 EXACT ID): verify live provider state by the durable
   * EXTERNAL template/build id a transition persisted — not by name. Reads the
   * exact provider row for that id, so it can't be fooled by name-list
   * pagination or an idempotent-adopt that reused a name. Returns 'missing' when
   * the id is absent/gone. Absent on providers with no external id concept.
   */
  getSnapshotStateByExternalId?(externalId: string): Promise<ProviderState>;

  /**
   * Optional agent-only fast path: produce `newSnapshotName` from a predecessor
   * `sourceSnapshotName` by swapping ONLY the kortix-agent binary (no rebuild).
   * Implemented by providers that control the host filesystem (Platinum). Absent
   * on providers without a rootfs handle (Daytona) — callers fall back to build.
   */
  swapAgent?(newSnapshotName: string, sourceSnapshotName: string): Promise<BuildSnapshotResult | void>;

  /** True iff the platform is wired up for this provider in the current env. */
  isConfigured(): boolean;
}

const ADAPTERS = new Map<string, SandboxProviderAdapter>();
ADAPTERS.set(daytonaProvider.id, daytonaProvider);
ADAPTERS.set(platinumProvider.id, platinumProvider);
ADAPTERS.set(e2bProvider.id, e2bProvider);

export function getSandboxProvider(id: string): SandboxProviderAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unknown sandbox provider: ${id}`);
  }
  return adapter;
}
