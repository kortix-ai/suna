import { config } from '../../config';
import { managedTransportAvailable } from '../resolution/descriptors';
import { managedLineup, resolvePlatformDefaultModelId, type ManagedModel } from './managed-models';

/**
 * The managed lineup this deployment can serve now: Platinum's list, when the
 * Platinum key is present. Read live: the lineup refreshes in the background.
 *
 * Kept apart from `managed-models.ts` so the lineup never imports the
 * resolution layer (`descriptors.ts` imports `ManagedModel` from it).
 */
export function servedManagedModels(): readonly ManagedModel[] {
  return managedLineup().filter(managedTransportAvailable);
}

/**
 * The platform default model this deployment can actually serve. Read this
 * anywhere a route ADVERTISES the default (`/model-picker`, `/model-defaults`)
 * or RESOLVES it (gateway routing) — never `config.LLM_GATEWAY_DEFAULT_MODEL`
 * directly, which is only what the operator asked for.
 */
export function platformDefaultModelId(): string {
  return resolvePlatformDefaultModelId(config.LLM_GATEWAY_DEFAULT_MODEL ?? '', servedManagedModels());
}

/** The platform vision model: the configured one when served, else the first served model that reads images. */
export function platformVisionModelId(): string {
  const configured = (config.LLM_GATEWAY_VISION_MODEL ?? '').trim();
  const served = servedManagedModels();
  if (configured && (configured.includes('/') || served.some((m) => m.id === configured && m.vision))) return configured;
  return served.find((m) => m.vision)?.id ?? configured;
}
