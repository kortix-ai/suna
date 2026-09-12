export type BootMark = { label: string; atMs: number }

/** Mutable host boot state shared with the selected runtime. */
export interface SandboxBootState {
  repoMaterializationError: string | null
  timeline: BootMark[]
  workspaceReady?: boolean
}
