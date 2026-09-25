/**
 * The pooled provider keys a session runs a model on.
 *
 * A model reached only through pooled keys (`pooled_provider_secrets`: keys
 * shared with the project, keys granted to one member, ChatGPT connections)
 * needs its session to select them: the gateway never picks a pooled key on
 * its own. The web asks the person which keys. A caller that names only a
 * model — the CLI, the SDK, a chat channel — gets every key it may use for
 * that model's provider, so they rotate.
 */
import { CODEX_AUTH_SECRET_NAME } from '../llm-gateway/models/codex-models';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { listUsableGatewaySecrets, queryUsableGatewaySecrets } from './account-resource';

/** Most keys one session may select per provider. */
export const MAX_KEYS_PER_PROVIDER = 10;

/** The key name the gateway reads for a provider's pooled keys. Null for an unknown provider. */
export function providerEnvVarOf(providerId: string): string | null {
  return providerId === 'codex' ? CODEX_AUTH_SECRET_NAME : (resolveCatalogUpstream(providerId)?.envVar ?? null);
}

/** The provider whose keys pay for a model, and the key name the gateway reads. Null for a Kortix model. */
export function providerKeyOf(model: string): { providerId: string; envVar: string } | null {
  const wire = toWireModel(model);
  if (!wire.includes('/')) return null;
  const providerId = wire.split('/')[0]!;
  const envVar = providerEnvVarOf(providerId);
  return envVar ? { providerId, envVar } : null;
}

/**
 * May a session hold these keys for the provider? Each must be active, stored
 * under the key name the gateway reads for the provider, and usable in the
 * project with `grantUserId`'s member grants. False for an unknown provider,
 * or when any id is not usable. True for no ids.
 *
 * Checks the keys, not a principal: the route has already authorized whoever
 * acts, and checks the session owner's project access itself.
 */
export async function mayUseProviderKeys(input: {
  accountId: string;
  projectId: string;
  /**
   * Whose member-granted keys count: the caller, or the person a private
   * session acts for. Null in a shared session: keys shared with the whole
   * project only (spec 2026-09-22 §2.3).
   */
  grantUserId: string | null;
  providerId: string;
  ids: string[];
}): Promise<boolean> {
  if (!input.ids.length) return true;
  const name = providerEnvVarOf(input.providerId);
  if (!name) return false;
  const ids = [...new Set(input.ids)];
  return (await queryUsableGatewaySecrets({ ...input, name, ids })).length === ids.length;
}

export interface ProviderKeySelection {
  providerId: string;
  envVar: string;
  secretIds: string[];
  labels: string[];
}

/**
 * Every pooled key the account member `userId` may use for the model's
 * provider in this project, oldest first, at most MAX_KEYS_PER_PROVIDER: the
 * keys stored under the key name the gateway reads for the provider. Member
 * grants count only for `grantUserId`. Null when there is none to select.
 */
export async function usableProviderKeys(input: {
  accountId: string;
  projectId: string;
  /** The account member who must read the project. */
  userId: string;
  /** As in `mayUseProviderKeys`. */
  grantUserId: string | null;
  model: string;
}): Promise<ProviderKeySelection | null> {
  const provider = providerKeyOf(input.model);
  if (!provider) return null;
  const keys = (await listUsableGatewaySecrets({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    grantUserId: input.grantUserId,
    providerId: provider.providerId,
    name: provider.envVar,
  })).slice(0, MAX_KEYS_PER_PROVIDER);
  if (!keys.length) return null;
  return { ...provider, secretIds: keys.map((key) => key.secretId), labels: keys.map((key) => key.label) };
}
