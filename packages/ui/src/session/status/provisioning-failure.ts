import type { UiTranslator } from '../../i18n';
import type { PendingSessionPrompt } from '@kortix/sdk';
import { readStartStash } from '@kortix/sdk/react';

interface ProvisioningFailurePresentation {
  title: string;
  message: string;
  retryable: boolean;
}

/** Build stable error-card copy from API-owned sandbox failure metadata. */
export function provisioningFailurePresentation(
  metadata: Record<string, unknown>,
  sandboxLabel: string | undefined,
  tI18nComplete: UiTranslator,
): ProvisioningFailurePresentation {
  const resolvedSandboxLabel = sandboxLabel ?? 'session';
  const category =
    typeof metadata.failureCategory === 'string' ? metadata.failureCategory : 'sandbox-provider';
  const message =
    (typeof metadata.errorMessage === 'string' && metadata.errorMessage) ||
    'The sandbox provider could not start this session. Try again.';

  if (category === 'provider-capacity') {
    return { title: tI18nComplete.raw('textb3e53ad64339'), message, retryable: true };
  }

  if (category === 'git-auth') {
    return { title: tI18nComplete.raw('textd557bdc340e8'), message, retryable: true };
  }

  return {
    title: tI18nComplete('text35e233062c2c', { value0: resolvedSandboxLabel }),
    message,
    retryable: true,
  };
}

/** Read the server-owned recovery copy. This function never consumes it. */
export function pendingSessionPromptFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): PendingSessionPrompt | null {
  const value = metadata?.pending_prompt;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prompt = value as Record<string, unknown>;
  if (typeof prompt.text !== 'string') return null;
  if (prompt.agent !== undefined && prompt.agent !== null && typeof prompt.agent !== 'string') {
    return null;
  }
  if (
    prompt.variant !== undefined &&
    prompt.variant !== null &&
    typeof prompt.variant !== 'string'
  ) {
    return null;
  }
  const model = prompt.model;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'object' || Array.isArray(model)) return null;
    const modelObject = model as Record<string, unknown>;
    if (typeof modelObject.providerID !== 'string' || typeof modelObject.modelID !== 'string') {
      return null;
    }
  }
  if (
    prompt.attachment_names !== undefined &&
    (!Array.isArray(prompt.attachment_names) ||
      prompt.attachment_names.some((name) => typeof name !== 'string'))
  ) {
    return null;
  }
  if (prompt.text.trim().length === 0 && (prompt.attachment_names?.length ?? 0) === 0) return null;
  const parsedModel =
    model &&
    typeof model === 'object' &&
    !Array.isArray(model) &&
    typeof (model as Record<string, unknown>).providerID === 'string' &&
    typeof (model as Record<string, unknown>).modelID === 'string'
      ? {
          providerID: (model as Record<string, unknown>).providerID as string,
          modelID: (model as Record<string, unknown>).modelID as string,
        }
      : null;
  const attachmentNames = Array.isArray(prompt.attachment_names)
    ? prompt.attachment_names.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    text: prompt.text,
    agent: typeof prompt.agent === 'string' ? prompt.agent : null,
    model: parsedModel,
    variant: typeof prompt.variant === 'string' ? prompt.variant : null,
    attachment_names: attachmentNames,
  };
}

/**
 * The prompt the failure card shows, and who delivers it on Retry.
 *
 * `redeliveredOnRestart` is true for `metadata.initial_prompt`: the restart
 * route (`provisionReplacementRuntime`) hands that prompt to the new runtime
 * itself, so Retry must only restart. A legacy `pending_prompt.text` and a
 * start stash exist only in the client, so Retry must POST them.
 */
export interface RecoveryPrompt extends PendingSessionPrompt {
  redeliveredOnRestart: boolean;
}

/**
 * The recovery copy, from the server when it has one and from this tab's start
 * stash otherwise. Never consumes either.
 *
 * `metadata.pending_prompt` is written by the session CREATE. The start stash
 * the composer wrote before navigating is the fallback while that row is not
 * read yet. Reading both keeps the failure card's "copy your prompt" and Retry
 * working before and after the session row loads.
 *
 * A session that an agent, a trigger, a channel, MCP or a marketplace install
 * created has neither: its first prompt is `metadata.initial_prompt`. That
 * prompt is shown only while `runtimeSessionId` is empty, which is the same
 * condition under which the restart re-delivers it.
 */
export function pendingSessionPromptForRecovery(
  sessionId: string,
  metadata: Record<string, unknown> | null | undefined,
  runtimeSessionId?: string | null,
): RecoveryPrompt | null {
  const fromMetadata = pendingSessionPromptFromMetadata(metadata);
  if (fromMetadata) return { ...fromMetadata, redeliveredOnRestart: false };
  const stash = readStartStash(sessionId);
  if (stash && stash.prompt.trim().length > 0) {
    return {
      text: stash.prompt,
      agent: stash.agent ?? null,
      model: stash.model ?? null,
      variant: stash.variant ?? null,
      attachment_names: [],
      redeliveredOnRestart: false,
    };
  }
  const initialPrompt = metadata?.initial_prompt;
  if (runtimeSessionId || typeof initialPrompt !== 'string' || initialPrompt.trim().length === 0) {
    return null;
  }
  return {
    text: initialPrompt,
    agent: null,
    model: null,
    variant: null,
    attachment_names: [],
    redeliveredOnRestart: true,
  };
}

/**
 * The prompt Retry must POST itself, or null when the restart alone delivers
 * it. Sending a `redeliveredOnRestart` prompt here would run it twice.
 */
export function recoveryPromptToSendOnRetry(
  prompt: RecoveryPrompt | null,
): PendingSessionPrompt | null {
  if (!prompt || prompt.redeliveredOnRestart) return null;
  const { redeliveredOnRestart: _redeliveredOnRestart, ...toSend } = prompt;
  return toSend;
}
