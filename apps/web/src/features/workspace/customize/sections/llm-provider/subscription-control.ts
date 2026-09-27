import { qk } from '@kortix/sdk/react';
import type { QueryClient } from '@tanstack/react-query';

import type { ProjectSecretsCache } from '../view/secret-optimistic-cache';
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

function isSubscriptionCredential(name: string): boolean {
  return name === CODEX_AUTH_JSON_SECRET_NAME || name === LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME;
}

export function subscriptionIsConnected(secretNames: Iterable<string>): boolean {
  for (const name of secretNames) {
    if (isSubscriptionCredential(name)) return true;
  }
  return false;
}

/**
 * Removes the subscription credential rows from the cached secrets list after
 * `DELETE /projects/:id/oauth/openai` succeeded.
 *
 * The card must not wait for a refetch to show the result. `GET /secrets`
 * loads the project manifest on every call, and the provider refresh that
 * follows a disconnect starts several more reads. Until one of them returned,
 * the card kept "ChatGPT subscription connected." and its Disconnect button.
 *
 * The cancel comes first: a read that started before the delete would
 * otherwise land after this write and put the credential back.
 */
export async function forgetSubscriptionCredentials(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  const queryKey = qk.project.secrets(projectId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<ProjectSecretsCache>(queryKey, (cache) => {
    if (!cache) return cache;
    if (Array.isArray(cache)) return cache.filter((item) => !isSubscriptionCredential(item.name));
    return { ...cache, items: cache.items.filter((item) => !isSubscriptionCredential(item.name)) };
  });
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
