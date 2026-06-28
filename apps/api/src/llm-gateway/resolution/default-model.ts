// Server-side default-model resolution: turns an incoming `auto` into the model
// the account/project/agent has configured (or undefined → the platform target).
// Resolved once at authentication and attached to the principal so it travels
// across the RPC hop to the standalone gateway pod. Caches keep the hot path off
// the DB. See ./choose-default-model for the (pure) precedence rule.

import type { AuthedPrincipal } from '@kortix/llm-gateway';
import {
  getAccountModelDefaults,
  getSessionResolutionContext,
  type AccountModelDefaults,
  type SessionResolutionContext,
} from '../../repositories/model-preferences';
import { chooseDefaultModel } from './choose-default-model';

const PREFS_TTL_MS = 30_000;
const SESSION_CTX_TTL_MS = 60_000;

const prefsCache = new Map<string, { value: AccountModelDefaults; expiresAt: number }>();
const sessionCtxCache = new Map<string, { value: SessionResolutionContext | null; expiresAt: number }>();

async function cachedAccountDefaults(accountId: string): Promise<AccountModelDefaults> {
  const hit = prefsCache.get(accountId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await getAccountModelDefaults(accountId);
  prefsCache.set(accountId, { value, expiresAt: Date.now() + PREFS_TTL_MS });
  return value;
}

async function cachedSessionContext(sessionId: string): Promise<SessionResolutionContext | null> {
  const hit = sessionCtxCache.get(sessionId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await getSessionResolutionContext(sessionId);
  sessionCtxCache.set(sessionId, { value, expiresAt: Date.now() + SESSION_CTX_TTL_MS });
  return value;
}

/** Drop the cached defaults for an account after a model-defaults write so the
 *  change takes effect on the next request rather than after the TTL. */
export function invalidateAccountModelDefaults(accountId: string): void {
  prefsCache.delete(accountId);
}

/**
 * Resolve the model that `auto` should become for a principal. Returns undefined
 * when nothing is configured (→ the gateway's platform `auto` target). The two
 * cached reads run in parallel; a principal with no session resolves on
 * project (from the principal) + account scope alone.
 */
export async function resolveDefaultModelForPrincipal(
  principal: AuthedPrincipal,
): Promise<string | undefined> {
  const [defaults, ctx] = await Promise.all([
    cachedAccountDefaults(principal.accountId),
    principal.sessionId
      ? cachedSessionContext(principal.sessionId)
      : Promise.resolve<SessionResolutionContext | null>(null),
  ]);

  return chooseDefaultModel({
    accountDefault: defaults.account,
    projectDefaults: defaults.projects,
    agentDefaults: defaults.agents,
    agentManifestModel: ctx?.agentManifestModel ?? null,
    projectId: ctx?.projectId ?? principal.projectId ?? null,
    agentName: ctx?.agentName ?? null,
    freeModelsOnly: principal.freeModelsOnly,
  });
}
