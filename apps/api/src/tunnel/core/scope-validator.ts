import { isTunnelCapability } from 'agent-tunnel';

export function isValidCapability(capability: string): boolean {
  return isTunnelCapability(capability);
}
