/**
 * May a live session switch to `model`? When only pooled keys reach it, the
 * session selects them here: this module checks for an existing selection,
 * selects the keys and stores them.
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
import { sessionProviderSecretPools } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { providerKeyOf, usableProviderKeys } from '../../secrets/provider-key-selection';
import { db } from '../../shared/db';
import { resolveSessionPersonalOwner } from './personal-resources';

/** Does the session have a selection for the provider? An empty one counts. */
async function hasProviderSelection(sessionId: string, providerId: string): Promise<boolean> {
  const [existing] = await db
    .select({ sessionId: sessionProviderSecretPools.sessionId })
    .from(sessionProviderSecretPools)
    .where(and(eq(sessionProviderSecretPools.sessionId, sessionId), eq(sessionProviderSecretPools.providerId, providerId)))
    .limit(1);
  return Boolean(existing);
}

/**
 * Decides whether the session may switch to `model`: true when the gateway can
 * serve it for this session. When the model needs
 * pooled keys and the session has no selection for its provider, stores the
 * selection that makes it servable. A selection another request stores first
 * wins: the model is then judged with that selection.
 */
export async function admitSessionModelChange(input: {
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
  /** The route's check that the caller may select these keys (agent grant, the caller's own access). */
  callerMaySelect: (providerId: string, secretIds: string[]) => Promise<boolean>;
}): Promise<boolean> {
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
  if (await isModelServableForAccount(probe)) return true;
  if (!input.mayPool) return false;

  const provider = providerKeyOf(input.model);
  if (!provider || (await hasProviderSelection(input.sessionId, provider.providerId))) {
    return false;
  }
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
    return false;
  }
  const { providerId, secretIds } = selection;
  if (!(await isModelServableForAccount({ ...probe, providerSecretPools: { [providerId]: secretIds } }))) {
    return false;
  }
  const stored = await db
    .insert(sessionProviderSecretPools)
    .values({ sessionId: input.sessionId, providerId, secretIds })
    .onConflictDoNothing({ target: [sessionProviderSecretPools.sessionId, sessionProviderSecretPools.providerId] })
    .returning({ sessionId: sessionProviderSecretPools.sessionId });
  if (stored.length) return true;
  // Another request stored a selection first. It stays; the model is judged
  // with it, as a later request would be.
  return isModelServableForAccount(probe);
}
