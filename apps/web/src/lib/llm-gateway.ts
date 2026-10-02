import { type KortixProject, modelRefToKey } from '@kortix/sdk';

/**
 * The `llm_gateway` feature flag has the two halves every flag has:
 *
 *  • AVAILABLE — the platform supports it here at all (an operator env gate).
 *  • ENABLED   — this project's effective state. Implies available.
 *
 * Prefer `useFeatureFlag(projectId, 'llm_gateway')` for a plain gate. These two
 * exist because several surfaces already hold a `KortixProject` and must decide
 * synchronously, without another hook.
 */

/** True when this project routes LLM calls through the managed gateway (the
 *  flag is ENABLED). */
export function isLlmGatewayEnabled(project: KortixProject | undefined): boolean {
  if (!project) return false;
  if (project.experimental?.llm_gateway === true) return true;
  return (
    project.experimental_features?.some((flag) => flag.key === 'llm_gateway' && flag.enabled) ??
    false
  );
}

/**
 * True when the platform exposes the LLM Gateway flag for this project — it may
 * still be switched OFF. Availability alone must never light up a surface: a
 * disabled feature is invisible, so the Customize rail and the command palette
 * both gate on {@link isLlmGatewayEnabled}. Use this only to explain WHY a flag
 * is absent, never to render its feature.
 */
export function isLlmGatewayAvailable(project: KortixProject | undefined): boolean {
  return (
    project?.experimental_features?.some((flag) => flag.key === 'llm_gateway' && flag.available) ??
    false
  );
}

/**
 * Read a STORED model ref (`opencode_model` on a channel binding, schedule,
 * or agent pin) back into the picker's `ModelKey`, honoring the project's
 * gateway mode. The SDK's `modelRefToKey` owns the rule; a gateway pin that
 * still carries the `kortix/` prefix resolves to the model, not to "unset".
 */
export function storedModelRefToKey(
  ref: string,
  llmGatewayEnabled: boolean,
): { providerID: string; modelID: string } {
  return modelRefToKey(ref, llmGatewayEnabled);
}
