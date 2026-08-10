import type { KortixWorkspace } from '@kortix/sdk';

/**
 * The `llm_gateway` feature flag has the two halves every flag has:
 *
 *  • AVAILABLE — the platform supports it here at all (an operator env gate).
 *  • ENABLED   — this workspace's effective state. Implies available.
 *
 * Prefer `useFeatureFlag(workspaceId, 'llm_gateway')` for a plain gate. These two
 * exist because several surfaces already hold a `KortixWorkspace` and must decide
 * synchronously, without another hook.
 */

/** True when this workspace routes LLM calls through the managed gateway (the
 *  flag is ENABLED). */
export function isLlmGatewayEnabled(workspace: KortixWorkspace | undefined): boolean {
  if (!workspace) return false;
  if (workspace.experimental?.llm_gateway === true) return true;
  return (
    workspace.experimental_features?.some((flag) => flag.key === 'llm_gateway' && flag.enabled) ??
    false
  );
}

/**
 * True when the platform exposes the LLM Gateway flag for this workspace — it may
 * still be switched OFF. Availability alone must never light up a surface: a
 * disabled feature is invisible, so the Customize rail and the command palette
 * both gate on {@link isLlmGatewayEnabled}. Use this only to explain WHY a flag
 * is absent, never to render its feature.
 */
export function isLlmGatewayAvailable(workspace: KortixWorkspace | undefined): boolean {
  return (
    workspace?.experimental_features?.some((flag) => flag.key === 'llm_gateway' && flag.available) ??
    false
  );
}
