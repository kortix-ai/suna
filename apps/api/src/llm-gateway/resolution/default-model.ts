import { type AuthedPrincipal, GatewayResolutionError } from '@kortix/llm-gateway';
import { AUTO_MODEL_ID } from '@kortix/llm-catalog';
import { connectedByokPickerModels } from '../models/picker-catalog';
import { listProjectSecretsSnapshot } from '../../projects/secrets';
import {
  type AccountModelDefaults,
  getAccountModelDefaults,
  getSessionAgentContext,
} from '../../repositories/model-preferences';
import { chooseDefaultModel } from './choose-default-model';
import { type ModelSource, chooseEffectiveModel, degradeUnservableDefault, toWireModel } from './effective';
import { resolveCandidates } from './resolve-candidates';

// Resolves the account/agent/project-configured default model for a gateway
// principal, once at authentication (in withResolvedTier). The result is attached
// to the principal as `defaultModel` and consumed by `pickAutoModel` to turn a
// request for the synthetic `auto` into the model the account actually wants.
//
// Resolution order (most-specific wins): per-agent default → project default →
// account default → undefined (the caller then falls back to the platform
// default). Per-session and explicit models never reach here — a concrete model
// is passed through unchanged.

const PREFS_TTL_MS = 30_000;
const SESSION_AGENT_TTL_MS = 60_000;

const prefsCache = new Map<string, { value: AccountModelDefaults; expiresAt: number }>();
const sessionAgentCache = new Map<string, { agentName: string | null; expiresAt: number }>();

async function cachedAccountDefaults(accountId: string): Promise<AccountModelDefaults> {
  const cached = prefsCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getAccountModelDefaults(accountId);
  prefsCache.set(accountId, { value, expiresAt: Date.now() + PREFS_TTL_MS });
  return value;
}

async function cachedSessionAgent(sessionId: string): Promise<string | null> {
  const cached = sessionAgentCache.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) return cached.agentName;
  const ctx = await getSessionAgentContext(sessionId);
  const agentName = ctx?.agentName ?? null;
  sessionAgentCache.set(sessionId, { agentName, expiresAt: Date.now() + SESSION_AGENT_TTL_MS });
  return agentName;
}

/** Drop a caller's prefs cache so a just-changed default takes effect immediately. */
export function invalidateAccountModelDefaults(accountId: string): void {
  prefsCache.delete(accountId);
}

/**
 * Last-resort degrade target when a configured default (or the platform
 * default itself) turns out unservable: the flagship model of any BYOK
 * provider the PROJECT has actually connected a key for. Reuses the exact
 * connected-provider lookup the model picker uses (picker-catalog's
 * connectedByokPickerModels) so "the default that's resolved/shown" and "the
 * models a project can pick from" never disagree — a self-host project that
 * connected OpenAI/Bedrock but not Codex/OpenRouter should land on ITS
 * connected provider, never get stuck pointing at a provider it never
 * connected. Returns null (→ the caller's unmodified platform default) when
 * the project has no BYOK key connected at all, or has no project context.
 */
async function connectedByokFallback(projectId: string | undefined): Promise<string | null> {
  if (!projectId) return null;
  try {
    const snapshot = await listProjectSecretsSnapshot(projectId);
    const connected = new Set(snapshot.names.map((n) => n.toUpperCase()));
    return connectedByokPickerModels(connected)[0]?.id ?? null;
  } catch {
    return null; // never let a secrets-read hiccup break default resolution
  }
}

export async function resolveDefaultModelForPrincipal(
  principal: AuthedPrincipal,
): Promise<string | undefined> {
  const defaults = await cachedAccountDefaults(principal.accountId);
  const hasAgentDefaults = Object.keys(defaults.agents).length > 0;
  const projectDefault = principal.projectId ? defaults.projects[principal.projectId] : undefined;
  // Fast path: nothing configured for this account/project → the platform default
  // applies (no session read needed).
  if (!defaults.account && !hasAgentDefaults && !projectDefault) return undefined;

  let agentName: string | null = null;
  if (hasAgentDefaults && principal.sessionId) {
    agentName = await cachedSessionAgent(principal.sessionId);
  }

  const chosen = chooseDefaultModel({
    accountDefault: defaults.account,
    agentDefaults: defaults.agents,
    agentName,
    projectDefault,
    freeModelsOnly: principal.freeModelsOnly,
  });

  const kept = await degradeUnservableDefault(
    chosen,
    { hasProject: !!principal.projectId },
    () =>
      isModelServableForAccount({
        userId: principal.userId,
        accountId: principal.accountId,
        projectId: principal.projectId as string,
        freeModelsOnly: principal.freeModelsOnly ?? false,
        model: chosen as string,
      }),
    () => connectedByokFallback(principal.projectId),
  );
  return kept ?? undefined;
}

/**
 * Whether a concrete wire model can actually be served for an account+project —
 * used to validate a default before persisting it. Reuses the exact request-time
 * resolution (`resolveCandidates`), so a model accepted here is guaranteed
 * resolvable at request time (managed only when the tier grants it, BYOK only
 * when the provider key is connected, codex only when the credential exists).
 * `auto` is rejected: a stored default must be concrete.
 *
 * `resolveCandidates` THROWS a typed `GatewayResolutionError` (provider_not_
 * connected, provider_reauth_required, model_disabled_on_deployment,
 * model_not_found, plan_upgrade_required, ...) instead of returning `[]`
 * whenever it can pin down WHY there's no upstream — the right shape for an
 * actual generation request, where the caller wants the specific reason
 * surfaced. This function answers a narrower yes/no question for every READ/
 * defaults/picker/servability caller in this file (and r4.ts's PUT), so every
 * one of those typed reasons collapses to "not servable" here — exactly the
 * old return-`[]` behavior these callers were built against, restored. A
 * passive "what's the default" read must never fail just because a provider
 * key isn't connected; only an actual generation attempt should. Anything
 * that ISN'T a GatewayResolutionError (a real bug) still propagates.
 */
export async function isModelServableForAccount(params: {
  userId: string;
  accountId: string;
  projectId: string;
  freeModelsOnly: boolean;
  model: string;
}): Promise<boolean> {
  if (params.model === AUTO_MODEL_ID || params.model === `kortix/${AUTO_MODEL_ID}`) return false;
  // Accept either the opencode ref (`kortix/<id>`) or the bare wire id — the
  // gateway resolves the bare id, so normalize before probing candidates.
  const wire = toWireModel(params.model);
  try {
    const candidates = await resolveCandidates(
      {
        userId: params.userId,
        accountId: params.accountId,
        projectId: params.projectId,
        freeModelsOnly: params.freeModelsOnly,
      },
      wire,
    );
    return candidates.length > 0;
  } catch (err) {
    if (err instanceof GatewayResolutionError) return false;
    throw err;
  }
}

/**
 * The effective model for a project/session AND where it came from — for honest
 * UI/Slack copy ("Sonnet 4.6 · project default") and the model-defaults GET.
 *
 * An `explicit` override (a channel/session pin) wins only when it's actually
 * servable for the account+project; an unservable pin (e.g. a BYOK model whose
 * key was disconnected, or a retired managed id) degrades to the project →
 * account → platform chain instead of producing a dead turn. The returned
 * `model` is a concrete gateway wire id, or null when only the platform default
 * applies (the caller omits it and the gateway resolves `auto`).
 */
export async function resolveEffectiveModel(params: {
  userId: string;
  accountId: string;
  projectId: string;
  agentName?: string | null;
  explicit?: string | null;
  freeModelsOnly: boolean;
}): Promise<{ model: string | null; source: ModelSource }> {
  if (params.explicit) {
    const servable = await isModelServableForAccount({
      userId: params.userId,
      accountId: params.accountId,
      projectId: params.projectId,
      freeModelsOnly: params.freeModelsOnly,
      model: params.explicit,
    });
    if (servable) return { model: toWireModel(params.explicit), source: 'explicit' };
  }
  const defaults = await getAccountModelDefaults(params.accountId);
  const chain = chooseEffectiveModel({
    agentDefault: params.agentName ? defaults.agents[params.agentName] : null,
    projectDefault: defaults.projects[params.projectId],
    accountDefault: defaults.account,
    freeModelsOnly: params.freeModelsOnly,
  });
  // Degrade a stale/unservable resolved default (e.g. a BYOK model whose key was
  // disconnected) to something the project can actually use right now, so the
  // UI's "resolved" model reflects what the gateway will actually serve rather
  // than a dead ref: first try any OTHER BYOK provider the project has
  // connected (connectedByokFallback), then finally the bare platform default.
  const kept = await degradeUnservableDefault(
    chain.model,
    { hasProject: true },
    () =>
      isModelServableForAccount({
        userId: params.userId,
        accountId: params.accountId,
        projectId: params.projectId,
        freeModelsOnly: params.freeModelsOnly,
        model: chain.model as string,
      }),
    () => connectedByokFallback(params.projectId),
  );
  if (!kept) return { model: null, source: 'platform' };
  // kept === chain.model means the originally-configured default WAS servable
  // (probe passed) — return it with its real source (agent/project/account).
  // Any other value is the connected-provider fallback degrade target, which
  // isn't the account's configured choice, so it's labeled 'platform' like
  // every other degrade-to-something-usable case.
  return kept === chain.model ? chain : { model: kept, source: 'platform' };
}
