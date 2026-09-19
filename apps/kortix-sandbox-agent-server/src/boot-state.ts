import type { ConfigProviderSummary } from './config-provider/types'

export type BootMark = { label: string; atMs: number }

/** Mutable host boot state shared with the selected runtime. */
export interface SandboxBootState {
  repoMaterializationError: string | null
  timeline: BootMark[]
  workspaceReady?: boolean
  /** What this boot's project acquisition did (src/config-provider). Null until it ran. */
  configProvider?: ConfigProviderSummary | null
  /**
   * A prepared-S3 start defers the optional history backfill until the runtime
   * is actually ready (not a fixed timer); the harness boot runs this at that point.
   */
  deferredHistoryBackfill?: (() => void) | null
}
