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

/**
 * Whether the ChatGPT accounts dialog can fix this failure for this viewer.
 * A member's own account serves only their private session (spec 2026-09-22
 * §2.3), and an explicit session selection is changed in session settings,
 * not by connecting another account. Unknown state offers nothing.
 */
export function chatGptActionApplies(input: {
  action: ChatGptConnectionAction;
  /** `sessionPersonalUser()`: the private session's creator, `null` when shared. */
  personalUser: string | null | undefined;
  viewerId: string | null | undefined;
  /** The session has its own ChatGPT selection; `undefined` while unknown. */
  explicitSelection: boolean | undefined;
}): boolean {
  const privateToViewer = !!input.viewerId && input.personalUser === input.viewerId;
  if (input.action === 'connect') return privateToViewer && input.explicitSelection === false;
  // Reconnecting fixes the viewer's own account, and in a shared session only
  // a selected account can be one: without a selection it runs on the project login.
  return privateToViewer || input.explicitSelection === true;
}
