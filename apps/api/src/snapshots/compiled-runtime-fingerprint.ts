export type CompiledBootMode = 'off' | 'shadow' | 'prefer' | 'required';

export function snapshotEmbedsAgentForBootMode(mode: CompiledBootMode): boolean {
  return mode === 'off' || mode === 'shadow';
}
