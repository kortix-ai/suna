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

  /** True iff the platform is wired up for this provider in the current env. */
  isConfigured(): boolean;
}
