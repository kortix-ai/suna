import type { Config } from '../config'

export type HarnessAssetOutcome = 'skipped' | 'current' | 'updated' | 'failed' | 'staged'

export interface HarnessAssetsInput {
  /** The adapter owns interpretation of its entries in the shared manifest. */
  manifest: { components?: unknown }
  setActivity: (label: string | null) => void
}

export interface HarnessAssetsResult {
  /** Existing component names are wire compatibility keys, not harness selectors. */
  components: Record<string, HarnessAssetOutcome>
  reasons: Record<string, string>
  /** Adapter-owned diagnostic values merged into the existing digest state. */
  state: Record<string, string>
}

/** Harness-owned asset installation, reconciliation, and skill placement. */
export interface HarnessAssetsService {
  readonly componentNames: readonly string[]
  resolveConfigDir(cfg: Config): Promise<string>
  injectSkills(configDir: string, bakedDir: string): Promise<void>
  /** Resolve failures to component outcomes; never discard another component's result. */
  reconcile(input: HarnessAssetsInput): Promise<HarnessAssetsResult>
  /**
   * Are the HARNESS's own updates latched off after a rollback?
   *
   * The daemon half has `agent.pinned` and reports it as `pinned` on
   * `/kortix/health`. A harness that can also roll itself back has a second
   * latch, and the control plane has one question — "will this box heal
   * itself" — so both feed the same field. An adapter with no rollback of its
   * own leaves this undefined.
   */
  updatesPinned?(): Promise<boolean>
}
