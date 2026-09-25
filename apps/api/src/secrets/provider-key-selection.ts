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
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { toWireModel } from '../llm-gateway/resolution/effective';
import { listUsableGatewaySecrets, type UsableGatewaySecret } from './account-resource';

/** Most keys one session may select per provider. */
export const MAX_KEYS_PER_PROVIDER = 10;

/** The key name the gateway reads for a provider's pooled keys. Null for an unknown provider. */
export function providerEnvVarOf(providerId: string): string | null {
  return providerId === 'codex' ? 'CODEX_AUTH_JSON' : (resolveCatalogUpstream(providerId)?.envVar ?? null);
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
 * The provider's pooled keys that `userId` may use in this project, oldest
 * first: every key needs `userId` to read the project, as the gateway requires
 * of the user a session runs as. A key granted to one member counts only for
 * `grantUserId`; null counts no member grant (spec 2026-09-22 §2.3). `ids`
 * limits the answer to those keys.
 */
export async function sessionUsableKeys(input: {
  accountId: string;
  projectId: string;
  userId: string;
  grantUserId: string | null;
  providerId: string;
  envVar: string;
  ids?: string[];
}): Promise<UsableGatewaySecret[]> {
  const keys = await listUsableGatewaySecrets({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    grantUserId: input.grantUserId,
    providerId: input.providerId,
    ids: input.ids,
  });
  return keys.filter((key) => key.name === input.envVar);
}

export interface ProviderKeySelection {
  providerId: string;
  envVar: string;
  secretIds: string[];
  labels: string[];
}

/**
 * Every pooled key `userId` may use for the model's provider in this project,
 * oldest first, at most MAX_KEYS_PER_PROVIDER. `grantUserId` is whose
 * member-granted keys count: the person a private session acts for, or null
 * in a shared one (spec 2026-09-22 §2.3). Null when there is none to select.
 */
export async function usableProviderKeys(input: {
  accountId: string;
  projectId: string;
  userId: string;
  grantUserId: string | null;
  model: string;
}): Promise<ProviderKeySelection | null> {
  const provider = providerKeyOf(input.model);
  if (!provider) return null;
  const keys = (await sessionUsableKeys({
    accountId: input.accountId,
    projectId: input.projectId,
    userId: input.userId,
    grantUserId: input.grantUserId,
    ...provider,
  })).slice(0, MAX_KEYS_PER_PROVIDER);
  if (!keys.length) return null;
  return { ...provider, secretIds: keys.map((key) => key.secretId), labels: keys.map((key) => key.label) };
}
