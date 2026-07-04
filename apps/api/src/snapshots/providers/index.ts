/**
 * Sandbox provider adapters.
 *
 * A provider builds and hosts the actual sandbox image. Today there's one:
 * Daytona. Future providers (e.g. Vercel Sandbox, local Docker) implement the
 * `SandboxProviderAdapter` interface and slot in here.
 *
 * The provider is identified by a stable string (`daytona`, `local`, …) that
 * lives on the template row. The session boot path resolves the adapter by
 * that string and delegates the actual snapshot build / state check.
 */

import { daytonaProvider } from './daytona';
import { platinumProvider } from './platinum';
import type { WarmRepoContext } from '../build-context';

interface SandboxResourceSpec {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}

export interface BuildableTemplate {
  /** Snapshot name the provider should write under. */
  snapshotName: string;
  /** Either `image` OR `userDockerfile` is set (not both). */
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
  /**
   * Per-project COLD warm: bake the project's repo checkout into /workspace at
   * build time. Threaded straight to `stageBuildContext` → the Dockerfile layer,
   * which clones the repo (build-time creds) and keeps /workspace. The image
   * stays capture:'none' (no memory snapshot) — BOTH providers boot it cold.
   * Absent for the shared default image (workspace stays empty).
   */
  warmRepo?: WarmRepoContext;
}

export type ProviderState =
  | 'active'
  | 'pulling'
  | 'building'
  | 'error'
  | 'build_failed'
  | 'removing'
  | 'missing'
  | string;

export interface BuildLogTap {
  /** Streamed per line from the provider build. */
  onLine?: (line: string) => void;
}

export interface SandboxProviderAdapter {
  readonly id: 'daytona' | 'local' | string;

  /**
   * Build the snapshot. The caller has already composed the layered Dockerfile
   * (user Dockerfile + Kortix runtime). Returns when the snapshot is `active`,
   * throws on terminal failure.
   */
  buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void>;

  /** Query the live provider state. Returns 'missing' if not found. */
  getSnapshotState(snapshotName: string): Promise<ProviderState>;

  /** Delete the snapshot (no-op if missing). */
  deleteSnapshot(snapshotName: string): Promise<void>;

  /**
   * Optional agent-only fast path: produce `newSnapshotName` from a predecessor
   * `sourceSnapshotName` by swapping ONLY the kortix-agent binary (no rebuild).
   * Implemented by providers that control the host filesystem (Platinum). Absent
   * on providers without a rootfs handle (Daytona) — callers fall back to build.
   */
  swapAgent?(newSnapshotName: string, sourceSnapshotName: string): Promise<void>;

  /** True iff the platform is wired up for this provider in the current env. */
  isConfigured(): boolean;
}

const ADAPTERS = new Map<string, SandboxProviderAdapter>();
ADAPTERS.set(daytonaProvider.id, daytonaProvider);
ADAPTERS.set(platinumProvider.id, platinumProvider);

export function getSandboxProvider(id: string): SandboxProviderAdapter {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unknown sandbox provider: ${id}`);
  }
  return adapter;
}
