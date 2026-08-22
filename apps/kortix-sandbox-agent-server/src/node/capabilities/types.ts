export type NodeCapabilityName = 'filesystem' | 'shell' | 'desktop'
export type NodeCapabilityHandler = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

export interface NodeCapabilityRegistry {
  methods: ReadonlyMap<string, NodeCapabilityHandler>
  names: readonly NodeCapabilityName[]
}
