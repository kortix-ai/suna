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
import { localDockerSnapshotProvider } from './local-docker';
import type { WarmRepoContext } from '../build-context';

interface SandboxResourceSpec {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}

export interface BuildableTemplate {
  /** Snapshot name the provider should write under. */
  snapshotName: string;
  /**
   * Exactly one of `image`, `userDockerfile`, or `baseImageRef` is set.
   */
  image?: string;
  userDockerfile?: string;
  /**
   * Per-project warm FAST PATH: a registry-addressable ref to an
   * already-built, active runtime image (the shared default) to `FROM`
   * instead of composing the full toolchain Dockerfile. When set, the
   * provider stages a minimal Dockerfile (see `stageWarmFromBaseContext`)
   * that only adds `warmRepo` on top — the toolchain (including the
   * Chromium install that per-project bakes could otherwise re-download
   * under a build-cache miss) is INHERITED, not re-run. Only meaningful
   * together with `warmRepo`; providers that don't support this (no
   * `getSnapshotImageRef`) never receive it — the caller falls back to
   * `userDockerfile` instead.
   */
  baseImageRef?: string;
  /** Optional entrypoint override; null means use the provider default. */
  entrypoint?: string[];
  /** Resource spec. */
  spec: SandboxResourceSpec;
  /** Telemetry: caller-facing slug for logs. */
  slug: string;
  /** Shared platform default (vs per-project). Every template is built cold. */
  isShared?: boolean;
  /**
   * Per-project COLD warm: bake the project's repo checkout into /workspace at
   * build time. Threaded straight to `stageBuildContext` (or, on the
   * `baseImageRef` fast path, `stageWarmFromBaseContext`) → the Dockerfile
   * layer, which clones the repo (build-time creds) and keeps /workspace. The
   * image stays capture:'none' (no memory snapshot) — BOTH providers boot it
   * cold. Absent for the shared default image (workspace stays empty).
   */
  warmRepo?: WarmRepoContext;
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
 * with no external-id concept (Daytona / e2b / local-docker return void).
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

  /** Delete the snapshot (no-op if missing). */
  deleteSnapshot(snapshotName: string): Promise<void>;
  /** List provider snapshots/templates owned by the current account. */
  listSnapshots(): Promise<Array<{ name: string }>>;

  /**
   * Optional: resolve a registry-addressable image reference for an
   * ALREADY-BUILT snapshot, for use as `BuildableTemplate.baseImageRef` on a
   * later build (the per-project warm FAST PATH — see builder.ts
   * `ensurePerProjectWarmImage`). Returns null when the snapshot doesn't exist,
   * the provider has no such reference to give, or on any lookup error — every
   * caller treats null as "fall back to the full rebuild path", never as a
   * hard failure. Absent on providers that don't expose an image reference at
   * all (Platinum, E2B, local-docker); callers must null-check the method
   * itself, not just its return value.
   */
  getSnapshotImageRef?(snapshotName: string): Promise<string | null>;

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
ADAPTERS.set(localDockerSnapshotProvider.id, localDockerSnapshotProvider);

export function getSandboxProvider(id: string): SandboxProviderAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unknown sandbox provider: ${id}`);
  }
  return adapter;
}
