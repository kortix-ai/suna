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
import { listUsableGatewaySecrets, type UsableGatewaySecret } from './account-resource';

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

/** Who asks: `userId` must read the project; member grants count only for `grantUserId`. */
interface KeyScope {
  accountId: string;
  projectId: string;
  /**
   * The account member who must read the project. Null for a principal that
   * is not an account member (a service account) and that the route has
   * already authorized: only keys shared with the whole project count.
   */
  userId: string | null;
  /**
   * Whose member-granted keys count: the person a private session acts for,
   * or null in a shared one — keys shared with the whole project only (spec
   * 2026-09-22 §2.3).
   */
  grantUserId: string | null;
}

/**
 * The provider's pooled keys `userId` may use in this project, oldest first:
 * active, stored under the key name the gateway reads for the provider, and
 * usable by `userId` as the gateway requires of the user a session runs as.
 * `ids` limits the answer to those keys. None for an unknown provider.
 */
async function providerKeys(input: KeyScope & { providerId: string; ids?: string[] }): Promise<UsableGatewaySecret[]> {
  const name = providerEnvVarOf(input.providerId);
  if (!name) return [];
  return listUsableGatewaySecrets({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    grantUserId: input.grantUserId,
    providerId: input.providerId,
    name,
    ids: input.ids,
  });
}

/**
 * May `userId`, with `grantUserId`'s member grants, use every one of these
 * keys for the provider? False for an unknown provider, or when any id is not
 * one of its usable keys. True for no ids.
 */
export async function mayUseProviderKeys(input: KeyScope & { providerId: string; ids: string[] }): Promise<boolean> {
  if (!input.ids.length) return true;
  const ids = [...new Set(input.ids)];
  return (await providerKeys({ ...input, ids })).length === ids.length;
}

export interface ProviderKeySelection {
  providerId: string;
  envVar: string;
  secretIds: string[];
  labels: string[];
}

/**
 * Every pooled key `userId` may use for the model's provider in this project,
 * oldest first, at most MAX_KEYS_PER_PROVIDER. Null when there is none to
 * select.
 */
export async function usableProviderKeys(input: KeyScope & { model: string }): Promise<ProviderKeySelection | null> {
  const provider = providerKeyOf(input.model);
  if (!provider) return null;
  const keys = (await providerKeys({ ...input, providerId: provider.providerId })).slice(0, MAX_KEYS_PER_PROVIDER);
  if (!keys.length) return null;
  return { ...provider, secretIds: keys.map((key) => key.secretId), labels: keys.map((key) => key.label) };
}
