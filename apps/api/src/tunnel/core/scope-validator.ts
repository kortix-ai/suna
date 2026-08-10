import { isTunnelCapability, validateTunnelPermissionScope } from 'agent-tunnel';

export interface ScopeValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: Record<string, unknown>;
}

export function isValidCapability(capability: string): boolean {
  return isTunnelCapability(capability);
}

export function validateScope(
  capability: string,
  scope: Record<string, unknown>,
): ScopeValidationResult {
  return validateTunnelPermissionScope(capability, scope);
}
