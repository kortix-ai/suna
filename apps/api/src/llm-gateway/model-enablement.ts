import { config } from '../config';
import { getProjectRoutingPolicy } from '../repositories/project-routing-policies';

// Per-project model enablement (opt-out). A project may turn specific wire
// models OFF; the gateway then refuses them everywhere (chat, Slack, triggers,
// raw API) and the picker hides them. Absent from the disabled set = usable.
//
// NOTE: distinct from ../llm-gateway/enablement.ts, which resolves the
// `llm_gateway` experimental FEATURE flag — not model on/off.

/** The wire-model ids this project has turned off. Empty when the feature is off
 *  or nothing is disabled. */
export async function getProjectDisabledModels(
  projectId: string | null | undefined,
): Promise<Set<string>> {
  if (!config.MODEL_ENABLEMENT_ENABLED || !projectId) return new Set();
  const policy = await getProjectRoutingPolicy(projectId);
  return new Set(policy?.disabledModels ?? []);
}

/** True when `wireModel` is disabled for `projectId`. */
export async function isModelDisabledForProject(
  projectId: string | null | undefined,
  wireModel: string,
): Promise<boolean> {
  if (!config.MODEL_ENABLEMENT_ENABLED || !projectId) return false;
  return (await getProjectDisabledModels(projectId)).has(wireModel);
}
