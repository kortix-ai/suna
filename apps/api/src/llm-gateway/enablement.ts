import { resolveFeatureFlag } from '../feature-flags/registry';

/** True only when the platform gateway is available and this project opted in. */
export function projectLlmGatewayEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'llm_gateway');
}
