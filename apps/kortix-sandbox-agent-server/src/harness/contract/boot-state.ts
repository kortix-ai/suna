import type { ConfigProviderSummary } from '@/services/workspace-provider/types'

export type { BootMark } from '@kortix/api-contract/runtime-relay'
import type { BootMark } from '@kortix/api-contract/runtime-relay'

/** Mutable host boot state shared with the selected runtime. */
export interface SandboxBootState {
  repoMaterializationError: string | null
  timeline: BootMark[]
  workspaceReady?: boolean
  /** What this boot's project acquisition did (src/services/config-provider). Null until it ran. */
  configProvider?: ConfigProviderSummary | null
  /**
   * A prepared-S3 start defers the optional history backfill until the runtime
   * is actually ready (not a fixed timer); the harness boot runs this at that point.
   */
  deferredHistoryBackfill?: (() => void) | null
}
