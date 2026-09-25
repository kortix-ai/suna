import type { GatewayErrorDetails } from '@kortix/sdk';

export type ChatGptConnectionAction = 'reconnect' | 'connect';

/** A ChatGPT subscription model id, with or without OpenCode's `kortix/` provider. */
const CHATGPT_MODEL = /^(?:kortix\/)?codex\//;

/**
 * Which ChatGPT fix a failed turn needs, if any. A resolution error names no
 * provider (`provider: ''`), so the routed model is what identifies the
 * member's ChatGPT subscription.
 */
export function chatGptConnectionAction(
  details: Pick<GatewayErrorDetails, 'code' | 'requestedModel' | 'resolvedModel'> | null | undefined,
): ChatGptConnectionAction | null {
  if (!details) return null;
  const model = details.resolvedModel ?? details.requestedModel ?? '';
  if (!CHATGPT_MODEL.test(model)) return null;
  if (details.code === 'provider_reauth_required') return 'reconnect';
  if (details.code === 'provider_not_connected') return 'connect';
  return null;
}
