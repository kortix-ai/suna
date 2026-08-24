import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME } from './constants';

/**
 * What the ChatGPT-subscription card offers, given what the project actually
 * holds.
 *
 * The card used to decide this from LOCAL state only (`phase`), which knows
 * nothing about a credential connected in another tab, another surface, or
 * before this page load. It therefore said "Connect ChatGPT" over an already
 * connected subscription and — the reason this file exists — offered no way to
 * REMOVE one. That was the whole product: a subscription could be connected
 * from four surfaces and disconnected from none.
 *
 * `providerDisconnectPlan` does carry `oauthProvider: 'openai'`, so removing
 * the OpenAI API KEY takes the subscription with it — but the openai row only
 * renders when `OPENAI_API_KEY` exists. Connect only the subscription (the
 * common case: it is the whole point of "sign in with ChatGPT") and there is no
 * row, no remove control, and no way back out.
 *
 * The server side was never the problem: `DELETE /projects/:id/oauth/openai`
 * deletes the credential, audits it, and refreshes the model catalog. Nothing
 * called it.
 */
export type SubscriptionAction = 'connect' | 'reconnect' | 'disconnect';

export function subscriptionIsConnected(secretNames: Iterable<string>): boolean {
  for (const name of secretNames) {
    if (name === CODEX_AUTH_JSON_SECRET_NAME || name === LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME) {
      return true;
    }
  }
  return false;
}

export function subscriptionPrimaryAction(input: {
  connected: boolean;
  failed: boolean;
}): SubscriptionAction {
  // A failure outranks the stored credential: the thing on file did not work,
  // so the useful button is the one that replaces it.
  if (input.failed) return 'reconnect';
  return input.connected ? 'disconnect' : 'connect';
}
