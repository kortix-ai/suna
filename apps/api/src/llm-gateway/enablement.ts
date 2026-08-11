import { resolveFeatureFlag } from '../feature-flags/registry';

/** True only when the platform gateway is available and this workspace opted in. */
export function workspaceLlmGatewayEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'llm_gateway');
}
