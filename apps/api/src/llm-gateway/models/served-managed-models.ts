import type { ManagedModel } from '@kortix/llm-catalog';
import { config } from '../../config';
import { managedTransportAvailable } from '../resolution/descriptors';
import {
  RUNTIME_MANAGED_MODELS,
  resolvePlatformDefaultModelId,
  servedManagedModels,
} from './managed-models';

/**
 * Config (`RUNTIME_MANAGED_MODELS`) joined with credentials (`descriptors`).
 *
 * Kept in its own module rather than in `managed-models.ts` so the config-only
 * registry never has to import the resolution layer — `descriptors.ts` already
 * imports `ManagedModel` from it, and a runtime edge back the other way would
 * make that a cycle.
 *
 * Both values are deployment constants: `RUNTIME_MANAGED_MODELS` is parsed once
 * at module load and every credential `managedTransportAvailable` reads comes
 * from validated config, so nothing here changes at runtime.
 */
export const SERVED_MANAGED_MODELS: readonly ManagedModel[] = servedManagedModels(
  RUNTIME_MANAGED_MODELS,
  managedTransportAvailable,
);

/**
 * The platform default model this deployment can actually serve. Read this
 * anywhere a route ADVERTISES the default (`/model-picker`, `/model-defaults`)
 * or RESOLVES it (gateway routing) — never `config.LLM_GATEWAY_DEFAULT_MODEL`
 * directly, which is only what the operator asked for.
 */
export function platformDefaultModelId(): string {
  return resolvePlatformDefaultModelId(
    config.LLM_GATEWAY_DEFAULT_MODEL ?? '',
    SERVED_MANAGED_MODELS,
  );
}
