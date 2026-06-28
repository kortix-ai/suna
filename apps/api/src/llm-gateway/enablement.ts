import { resolveExperimentalFeature } from '../experimental/features';

/** True only when the platform gateway is available and this project opted in. */
export function projectLlmGatewayEnabled(metadata: unknown): boolean {
  return resolveExperimentalFeature(metadata, 'llm_gateway');
}
