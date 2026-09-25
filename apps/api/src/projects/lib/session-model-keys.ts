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
 *
 * Sharing changes that scope too: `checkSessionSharingChange` below.
 */
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { providerKeyOf, usableProviderKeys } from '../../secrets/provider-key-selection';
import { resolveSessionPersonalOwner, type PersonalSessionVisibility } from './personal-resources';

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

export type SessionSharingChange =
  | {
      ok: true;
      /** Keys to store as the session's selection for the provider; null when none change. */
      selected: { providerId: string; secretIds: string[] } | null;
    }
  | {
      ok: false;
      /** The model no key shared with the project can run (gateway wire id). */
      model: string;
    };

/**
 * May the session take `visibility`, and which pooled keys does it switch to?
 *
 * Sharing takes the owner's personal keys away: the gateway serves a session
 * that is not private with nobody's (spec 2026-09-22 §2.3). A private session
 * whose model ran only on them — its owner's own ChatGPT connection, keys
 * granted to its owner — could not run its model after the share. On dev
 * (2026-09-25) the share answered 200, and the session's model then answered
 * 400 INVALID_SESSION_MODEL; every turn would have failed with "Connect Codex".
 *
 * A share that would do that selects every key shared with the whole project
 * for the model's provider, as a model change does. With none that runs the
 * model, the share is refused. Only the scope change is checked: a session
 * that cannot run its model already is not the share's doing.
 */
export async function checkSessionSharingChange(input: {
  accountId: string;
  projectId: string;
  sessionId: string;
  /** The session's creator: its turns run as this user. */
  owner: string;
  freeModelsOnly: boolean;
  /** The model the session runs (`opencode_model`); null when the gateway picks one. */
  model: string | null;
  /** The visibility the change stores. */
  visibility: PersonalSessionVisibility;
  /** Pooled keys may be selected: the project's flag is on and a human owns the session. */
  mayPool: boolean;
  /** The route's check that the caller may select these keys (agent grant, the caller's own access). */
  callerMaySelect: (providerId: string, secretIds: string[]) => Promise<boolean>;
}): Promise<SessionSharingChange> {
  const unchanged = { ok: true as const, selected: null };
  if (!input.model) return unchanged;
  const scope = {
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    legacyUserId: input.owner,
  };
  const before = await resolveSessionPersonalOwner(scope).catch(() => null);
  if (!before) return unchanged;
  const after = await resolveSessionPersonalOwner({ ...scope, visibility: input.visibility }).catch(() => null);
  if (after) return unchanged;

  const probe = {
    userId: input.owner,
    accountId: input.accountId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    freeModelsOnly: input.freeModelsOnly,
    model: input.model,
  };
  if (await isModelServableForAccount({ ...probe, personalUserId: null })) return unchanged;
  if (!(await isModelServableForAccount({ ...probe, personalUserId: before }))) return unchanged;

  const selection = input.mayPool
    ? await usableProviderKeys({
        accountId: input.accountId,
        projectId: input.projectId,
        userId: input.owner,
        grantUserId: null,
        model: input.model,
      }).catch(() => null)
    : null;
  if (selection && (await input.callerMaySelect(selection.providerId, selection.secretIds))) {
    const selected = { providerId: selection.providerId, secretIds: selection.secretIds };
    const servable = await isModelServableForAccount({
      ...probe,
      personalUserId: null,
      providerSecretPools: { [selected.providerId]: selected.secretIds },
    });
    if (servable) return { ok: true, selected };
  }
  return { ok: false, model: toWireModel(input.model) };
}
