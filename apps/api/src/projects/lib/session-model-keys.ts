/**
 * May a live session switch to `model`, and which pooled keys does it select?
 *
 * Checked in the personal-key scope the gateway uses for that session
 * (`resolveSessionPersonalOwner`, spec 2026-09-22 §2.3). `PUT
 * /sessions/:id/model` used to check with the owner's own keys: a session
 * shared with the project accepted a ChatGPT model reached only through its
 * owner's own connection (dev, 2026-09-25), and the gateway, which uses
 * nobody's personal keys in a shared session, would fail every turn with
 * "Connect Codex to use this model".
 *
 * A model that only pooled keys reach selects every key the session may use
 * for its provider, so they rotate — when the session has no selection for
 * that provider yet. One made on purpose, an empty one included, stays.
 */
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { providerKeyOf, usableProviderKeys } from '../../secrets/provider-key-selection';
import { resolveSessionPersonalOwner } from './personal-resources';

export interface SessionModelChange {
  servable: boolean;
  /** Keys to store as the session's selection for the provider; null when none. */
  selected: { providerId: string; secretIds: string[] } | null;
}

export async function checkSessionModelChange(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  /** The session's creator: its turns run as this user. */
  owner: string;
  /** The person making the change. */
  caller: string;
  freeModelsOnly: boolean;
  model: string;
  /** Pooled keys may be selected: the project's flag is on and a human owns the session. */
  mayPool: boolean;
  /** Does the session already have a selection for this provider? */
  hasSelection: (providerId: string) => Promise<boolean>;
  /** The route's check that the caller may select these keys (agent grant, the caller's own access). */
  callerMaySelect: (providerId: string, secretIds: string[]) => Promise<boolean>;
}): Promise<SessionModelChange> {
  const personalUserId = await resolveSessionPersonalOwner({
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    legacyUserId: input.owner,
  }).catch(() => null);
  const probe = {
    userId: input.owner,
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    freeModelsOnly: input.freeModelsOnly,
    model: input.model,
    personalUserId,
  };
  if (await isModelServableForAccount(probe)) return { servable: true, selected: null };
  if (!input.mayPool) return { servable: false, selected: null };

  const provider = providerKeyOf(input.model);
  if (!provider || (await input.hasSelection(provider.providerId))) return { servable: false, selected: null };
  // The session's own scope, and personal keys only when the owner makes the
  // change: another person, a manager, never selects the owner's own keys.
  const selection = await usableProviderKeys({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.owner,
    grantUserId: input.caller === input.owner ? personalUserId : null,
    model: input.model,
  }).catch(() => null);
  if (!selection || !(await input.callerMaySelect(selection.providerId, selection.secretIds))) {
    return { servable: false, selected: null };
  }
  const selected = { providerId: selection.providerId, secretIds: selection.secretIds };
  const servable = await isModelServableForAccount({
    ...probe,
    providerSecretPools: { [selected.providerId]: selected.secretIds },
  });
  return { servable, selected: servable ? selected : null };
}
