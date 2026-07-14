import type { ModelKey } from '@/hooks/runtime/use-runtime-local';

export const NO_MODEL_AVAILABLE_ACTION_MESSAGE =
  'Connect a model via provider first or upgrade your Kortix subscription.';

export function isModelRequiredButUnavailable({
  modelRequired,
  selectedModel,
  lockForQuestion,
}: {
  modelRequired: boolean;
  selectedModel: ModelKey | null | undefined;
  lockForQuestion: boolean;
}): boolean {
  return modelRequired && !lockForQuestion && !selectedModel;
}

/**
 * ONE direct action for a capability-governed send block — see
 * `composer-capabilities` (`blocking_reason`) and
 * docs/specs/2026-07-14-provider-auth-model-management.md §5.3. Never the
 * generic "No models available for this session yet" (spec-banned): an
 * unauthenticated harness reads as "Connect <Harness>", a ready connection
 * that still needs an explicit model reads as "Choose a model for
 * <connection>". Falls back to the raw server reason when neither shape is
 * known (e.g. an ambiguous-connection message) so nothing is silently
 * swallowed.
 */
export function deriveComposerBlockingAction(input: {
  blockingReason: string | null;
  authReady: boolean;
  harnessLabel?: string | null;
  connectionLabel?: string | null;
}): string | null {
  if (!input.blockingReason) return null;
  if (!input.authReady) {
    return input.harnessLabel ? `Connect ${input.harnessLabel}` : input.blockingReason;
  }
  return input.connectionLabel
    ? `Choose a model for ${input.connectionLabel}`
    : input.blockingReason;
}
