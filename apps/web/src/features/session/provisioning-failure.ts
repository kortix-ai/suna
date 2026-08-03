import type { PendingSessionPrompt } from '@kortix/sdk';
import type { StartStash } from '@kortix/sdk/react';

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

/** Build the browser delivery stash only after the user selects Retry. */
export function startStashFromPendingSessionPrompt(prompt: PendingSessionPrompt): StartStash {
  return {
    prompt: prompt.text,
    agent: prompt.agent ?? null,
    model: prompt.model ?? null,
    variant: prompt.variant ?? null,
  };
}
