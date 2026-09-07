export type RuntimeModelKey = { providerID: string; modelID: string };

export type ProjectRuntimeIdentity = 'unknown' | 'pi-worker' | 'opencode';

export const RUNTIME_ATTACHMENTS_UNAVAILABLE_MESSAGE =
  'Attachments are not available in this session';

/**
 * A project session may change compiled prompt fields only after the control
 * plane proves that it runs OpenCode. Pi compiles one agent and model into the
 * worker and accepts no reasoning variant. Unknown stays locked because a
 * prompt can be submitted before the project-session query resolves.
 */
export function runtimePromptOverridesEnabled(input: {
  hasProjectSession: boolean;
  projectRuntimeIdentity: ProjectRuntimeIdentity;
  sandboxIsPiWorker: boolean;
}): boolean {
  if (input.projectRuntimeIdentity === 'pi-worker' || input.sandboxIsPiWorker) {
    return false;
  }
  if (!input.hasProjectSession) return true;
  return input.projectRuntimeIdentity === 'opencode';
}

/** Return the user-facing refusal before a text-only runtime sees a file part. */
export function runtimePromptFilesError(input: {
  attachmentsEnabled: boolean;
  attachmentCount: number;
}): string | null {
  return !input.attachmentsEnabled && input.attachmentCount > 0
    ? RUNTIME_ATTACHMENTS_UNAVAILABLE_MESSAGE
    : null;
}

/**
 * Resolve the runtime fields that may cross the prompt boundary.
 *
 * Pi accepts only its compiled agent and model and no `variant`. Omitting all
 * three selects that compiled contract without trusting stale localStorage or
 * a queued override captured before the runtime changed.
 */
export function resolveRuntimePromptOverrides(input: {
  agentEnabled: boolean;
  modelEnabled: boolean;
  variantEnabled: boolean;
  overrideAgent?: string | null;
  selectedAgent?: string | null;
  overrideModel?: RuntimeModelKey | null;
  selectedModel?: RuntimeModelKey | null;
  overrideVariant?: string | null;
  selectedVariant?: string | null;
}): { agent?: string; model?: RuntimeModelKey; variant?: string } {
  const agent = input.overrideAgent !== undefined ? input.overrideAgent : input.selectedAgent;
  const model =
    input.overrideModel !== undefined ? input.overrideModel : (input.selectedModel ?? null);
  const variant =
    input.overrideVariant !== undefined ? input.overrideVariant : (input.selectedVariant ?? null);

  return {
    ...(input.agentEnabled && agent ? { agent } : {}),
    ...(input.modelEnabled && model ? { model } : {}),
    ...(input.variantEnabled && variant ? { variant } : {}),
  };
}
