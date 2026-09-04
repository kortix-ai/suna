import type { KortixProject } from '@kortix/sdk';

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
 * gateway mode.
 *
 *  • Gateway ON — refs are gateway wire ids that live under the synthetic
 *    `kortix` provider in the picker namespace (`wireToModelKey`).
 *  • Gateway OFF — refs are OpenCode's native `provider/model` and split on
 *    the FIRST slash (the model id may itself contain slashes, e.g.
 *    `openrouter/z-ai/glm-4.7-flash`). Mapping them through `wireToModelKey`
 *    made every native pin render as "unset": the lookup key claimed
 *    providerID `kortix`, which no native catalog contains.
 *
 * A slash-less ref off-gateway has no native provider; it falls back to the
 * gateway shape, which simply fails the catalog lookup (renders unset) —
 * never a crash.
 */
export function storedModelRefToKey(
  ref: string,
  llmGatewayEnabled: boolean,
): { providerID: string; modelID: string } {
  if (!llmGatewayEnabled) {
    const slash = ref.indexOf('/');
    if (slash > 0 && slash < ref.length - 1) {
      return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) };
    }
  }
  return { providerID: 'kortix', modelID: ref };
}
