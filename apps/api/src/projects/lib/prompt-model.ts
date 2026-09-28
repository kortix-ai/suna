/**
 * Which model a prompt carries.
 *
 * The model a turn runs lives in THREE places:
 *   1. `project_sessions.metadata.opencode_model` — the row's pin
 *   2. `KORTIX_OPENCODE_MODEL`                    — the box's process env
 *   3. OpenCode's own per-session state           — what the turn ACTUALLY uses
 *
 * #7957 converged (1) and (2). Measured on dev immediately afterwards: the row
 * read `deepseek-v4.1-flash` with `opencode_model_source: 'repointed'`, the box
 * carried the new env, and the very next turn still ran `grok-4.6` and still
 * died on "The grok-4.6 model was retired from Kortix's managed lineup".
 * `KORTIX_OPENCODE_MODEL` only seeds the default for a NEW OpenCode session; an
 * existing one keeps the model it was created with, forever.
 *
 * So a re-pointed pin has to ride the prompt. `triggerModelOverride` already
 * carries this exact rule for triggers — its comment records the same shape
 * from prod, a July session pinned to a model the account could no longer use.
 * An ordinary prompt never got it.
 */
import { triggerModelOverride } from './triggers';

export interface PromptModel {
  providerID: string;
  modelID: string;
}

/**
 * PURE. The caller's model always wins. Otherwise a `repointed` pin is sent,
 * and nothing else is.
 *
 * The scope is deliberately narrow and self-limiting. `repointed` marks a pin
 * the PLATFORM moved because the user's own choice stopped existing, so sending
 * it overrides nobody's decision. `PUT /model` writes `explicit` and pushes to
 * the box itself, so a human changing the model turns this off permanently.
 */
export function promptModelOverride(
  callerModel: { providerID?: unknown; modelID?: unknown } | null | undefined,
  sessionMetadata: Record<string, unknown> | null | undefined,
): PromptModel | null {
  if (
    callerModel &&
    typeof callerModel.providerID === 'string' &&
    typeof callerModel.modelID === 'string'
  ) {
    return { providerID: callerModel.providerID, modelID: callerModel.modelID };
  }
  const metadata = sessionMetadata ?? {};
  if (metadata.opencode_model_source !== 'repointed') return null;
  if (typeof metadata.opencode_model !== 'string') return null;
  return triggerModelOverride(metadata.opencode_model)?.model ?? null;
}
