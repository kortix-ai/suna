import type { PendingSessionPrompt } from '@kortix/sdk';
import { readStartStash, type StartStash } from '@kortix/sdk/react';

export interface ProvisioningFailurePresentation {
  title: string;
  message: string;
  retryable: boolean;
}

/** Build stable error-card copy from API-owned sandbox failure metadata. */
export function provisioningFailurePresentation(
  metadata: Record<string, unknown>,
  sandboxLabel = 'session',
): ProvisioningFailurePresentation {
  const category =
    typeof metadata.failureCategory === 'string' ? metadata.failureCategory : 'sandbox-provider';
  const message =
    (typeof metadata.errorMessage === 'string' && metadata.errorMessage) ||
    'The sandbox provider could not start this session. Try again.';

  if (category === 'provider-capacity') {
    return { title: 'Sandbox capacity is full', message, retryable: true };
  }

  if (category === 'git-auth') {
    return { title: 'Git access failed', message, retryable: true };
  }

  return {
    title: `Couldn't start ${sandboxLabel}`,
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
 * The recovery copy, from the server when it has one and from this tab's start
 * stash otherwise. Never consumes either.
 *
 * `metadata.pending_prompt` is written by the session CREATE, so it exists only
 * when the send created the session. A send that reused a WARM session created
 * nothing, so its prompt lives only in the start stash the composer wrote before
 * navigating. Reading both is what keeps the failure card's "copy your prompt"
 * and Retry working identically on either path.
 */
export function pendingSessionPromptForRecovery(
  sessionId: string,
  metadata: Record<string, unknown> | null | undefined,
): PendingSessionPrompt | null {
  const fromMetadata = pendingSessionPromptFromMetadata(metadata);
  if (fromMetadata) return fromMetadata;
  const stash = readStartStash(sessionId);
  if (!stash || stash.prompt.trim().length === 0) return null;
  return {
    text: stash.prompt,
    agent: stash.agent ?? null,
    model: stash.model ?? null,
    variant: stash.variant ?? null,
    attachment_names: [],
  };
}

/** Build the browser delivery stash only after the user selects Retry. */
export function startStashFromPendingSessionPrompt(prompt: PendingSessionPrompt): StartStash {
  return {
    prompt: prompt.text,
    agent: prompt.agent ?? null,
    model: prompt.model ?? null,
    variant: prompt.variant ?? null,
  };
}
