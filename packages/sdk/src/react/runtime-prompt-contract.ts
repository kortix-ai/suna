import type { PromptPart, SendMessageOptions } from './use-opencode-sessions/keys';

export type SessionRuntimeKind = 'opencode' | 'pi-worker';

export interface RuntimePromptInput {
  runtime: SessionRuntimeKind;
  parts: PromptPart[];
  options?: SendMessageOptions;
}

export interface NormalizedRuntimePrompt {
  parts: PromptPart[];
  options?: SendMessageOptions;
}

/**
 * Enforce the prompt contract at the shared SDK boundary.
 *
 * A host can render stale model, agent, or attachment state while a session is
 * starting. Pi runs the model and agent compiled into its immutable bundle, so
 * the SDK removes model/agent overrides and accepts immutable image references.
 * Reasoning remains a per-prompt setting validated by the selected worker model.
 */
export function normalizeSessionPromptForRuntime(
  input: RuntimePromptInput,
): NormalizedRuntimePrompt {
  if (input.runtime === 'opencode') {
    return {
      parts: input.parts,
      ...(input.options ? { options: input.options } : {}),
    };
  }

  if (input.parts.some((part) => part.type !== 'text' && !(part.type === 'file' &&
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.mime) &&
    /^kortix-attachment:sha256:[a-f0-9]{64}$/.test(part.url) && !part.source))) {
    throw new Error('Pi worker prompts accept text and immutable image attachments only');
  }

  return {
    parts: input.parts,
    ...(input.options?.variant ? { options: { variant: input.options.variant } } : {}),
  };
}
