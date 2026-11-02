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
  /** The harness release on disk after this pass. Absent when the pass could not tell. */
  version?: string
}

/** Harness-owned asset installation, reconciliation, and skill placement. */
export interface HarnessAssetsService {
  /** The harness these assets belong to, as health names it (`pi`). */
  readonly harness: string
  readonly componentNames: readonly string[]
  /** IMAGE BUILD ONLY: the harness release the image carries, or undefined when it cannot tell. */
  bakedVersion?(): Promise<string | undefined>
  /** The managed-skill overlay was rewritten after boot: the runtime reloads its skills. */
  skillsUpdated?(): Promise<void>
  /** Resolve failures to component outcomes; never discard another component's result. */
  reconcile(input: HarnessAssetsInput): Promise<HarnessAssetsResult>
}
