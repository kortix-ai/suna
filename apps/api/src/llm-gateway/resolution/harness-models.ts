/**
 * The single server-side answer to "for this project and this harness, which
 * models are available, which is the default, and can a session start" —
 * concept 1.4 ("availability resolution") of
 * docs/specs/2026-07-21-model-resolution-refactor-plan.md. Nothing outside
 * this module may compute a credential's health, a credential's upstream
 * shape (gateway vs direct), or whether a catalog entry is reachable for a
 * project — every other caller (`composer-capabilities.ts`'s
 * `resolveProjectComposerState`, the session-start gate, the CLI/web/mobile
 * surfaces reading `/composer-capabilities`) consumes this module's answer;
 * none of them re-derive it.
 *
 * The closed state union is deliberate and exhaustive — `ready | no_credential
 * | expired | healthy_but_no_models` — so "empty model list but startable"
 * cannot happen: a catalog-driven harness (`ownsDefaultModel: false`) whose
 * credential is healthy but whose conditioned catalog comes back empty is
 * `healthy_but_no_models`, never `ready` with `models: []`. A harness-owned
 * harness (`ownsDefaultModel: true` — Claude, Codex) is `ready` with an
 * empty `models` array by construction (it never had a catalog to begin
 * with) — the ONLY producer of `HarnessModelResolution` values is
 * `resolveHarnessModels` below, and its control flow never returns `ready`
 * for a catalog-driven harness whose conditioned model list is empty (see
 * the `healthy_but_no_models` branch) — enforced by construction, pinned by
 * `harness-models.test.ts`'s exhaustive-state regression.
 */
import { CATALOG } from '@kortix/llm-catalog';
import {
  CREDENTIAL_CUSTODY,
  type CredentialCustody,
  HARNESSES,
  type HarnessAuthKind,
  type HarnessId,
} from '@kortix/shared/harnesses';

import { getCachedAccountTier } from '../../billing/services/entitlements';
import { accountIsFreeTierForModels } from '../../billing/services/tiers';
import { config } from '../../config';
import { CodexRefreshError, resolveCodexCredential } from '../credentials/codex';
import { gatewayModelCatalog } from '../models/catalog-models';
import { codexModelIds } from '../models/codex-models';
import { RUNTIME_MANAGED_MODELS } from '../models/managed-models';
import { projectPickerCatalog } from '../models/picker-catalog';

export type UpstreamKind = 'gateway' | 'direct';

/** A model in the canonical `{provider}/{model}` (or `kortix/auto`,
 *  `codex/{model}`) grammar, ALWAYS carrying its real upstream provider id —
 *  no client of this module ever needs to guess a model's provider by
 *  parsing the wire id. */
export interface ResolvedModel {
  id: string;
  name: string;
  provider: string;
}

export interface CredentialRef {
  kind: HarnessAuthKind;
  scope: 'shared' | 'personal';
}

export type HarnessModelResolutionState =
  | 'ready'
  | 'no_credential'
  | 'expired'
  | 'healthy_but_no_models';

export interface HarnessModelResolution {
  state: HarnessModelResolutionState;
  harness: HarnessId;
  /** `null` only for `no_credential` — there is no credential to have an
   *  upstream shape at all. */
  upstreamKind: UpstreamKind | null;
  /** `null` only for `no_credential`. */
  credentialRef: CredentialRef | null;
  /** Mirrors `HARNESSES[harness].ownsDefaultModel` — carried on every
   *  variant so a caller never needs a second lookup to know whether an
   *  empty `models` array is expected or a symptom. */
  ownsDefaultModel: boolean;
  /** Non-empty iff `state === 'ready' && !ownsDefaultModel`. Provider-tagged,
   *  credential-conditioned — the narrowed list, never the unconditioned
   *  ~4,900-entry catalog dump. */
  models: ResolvedModel[];
  /** Populated only when `state === 'ready'`; meaningful only for a
   *  catalog-driven harness (`kortix/auto` when the managed route is alive,
   *  else the first reachable model). `null` for `ownsDefaultModel` harnesses
   *  — they have no catalog for a "default" to name. This is NOT the
   *  account/agent preference chain (`llm-gateway/resolution/effective.ts`,
   *  untouched, a separate existing concern) — it only names the structural
   *  sentinel when this resolution has one. */
  default: string | null;
  /** `null` only when `state === 'ready'`. */
  reason: string | null;
}

/**
 * `gateway` when a resolved credential's raw material MAY be relayed through
 * a Kortix-operated endpoint; `direct` when it must only ever be handed to
 * the harness's own already-running process. Pure function of
 * `CREDENTIAL_CUSTODY` (`packages/shared/src/harnesses.ts`) — the one
 * authored table — never a second per-harness judgment call.
 */
export function upstreamKindForCredential(kind: HarnessAuthKind): UpstreamKind {
  return CREDENTIAL_CUSTODY[kind] === 'direct-only' ? 'direct' : 'gateway';
}

/** Thrown by `assertRelayEligible` — the structural guarantee that a
 *  `direct-only` credential kind (Claude subscription, native config) can
 *  never be resolved into a relay/gateway upstream, mirroring the same
 *  guarantee `billingMode` already gives Codex (`descriptors.ts`'s
 *  `codexDescriptor` never produces a Kortix-managed billing mode). */
export class CredentialCustodyViolationError extends Error {
  constructor(
    readonly kind: HarnessAuthKind,
    readonly custody: CredentialCustody,
  ) {
    super(
      `credential kind "${kind}" is ${custody} and can never be resolved to a relay/gateway upstream`,
    );
    this.name = 'CredentialCustodyViolationError';
  }
}

/** Throws `CredentialCustodyViolationError` for a `direct-only` kind. Call
 *  this at every site that is about to build a relay/gateway-shaped upstream
 *  from a resolved credential — never silently degrade. */
export function assertRelayEligible(kind: HarnessAuthKind): void {
  if (CREDENTIAL_CUSTODY[kind] === 'direct-only') {
    throw new CredentialCustodyViolationError(kind, CREDENTIAL_CUSTODY[kind]);
  }
}

/**
 * Whether `kind`'s raw material is present/enabled for this project — a
 * presence-and-flag check, NOT a live health probe (Claude/generic API-key
 * live validation is out of this pass's scope — see
 * docs/specs/2026-07-21-model-resolution-refactor-plan.md §9's Phase 4.2 note).
 * `managed_gateway`'s flag continues to gate whether the managed route is
 * OFFERED at all — it stops being treated as proof the route actually has
 * something to serve; that real reachability check lives in
 * `conditionedCatalogModels` below (replacing `managedGatewayHasNothingToRouteTo`).
 *
 * Moved here (from `composer-capabilities.ts`'s now-deleted
 * `connectionConfigured`) because credential presence is concept 1.1
 * (credential), gateway-owned per the plan's ownership table — the
 * `projects/lib` layer consumes this for its own connections-LISTING UI
 * (`buildHarnessConnections`), it does not own the fact.
 */
export function isCredentialConfigured(
  kind: HarnessAuthKind,
  env: Record<string, string>,
  gatewayEnabled: boolean,
  nativeConfigReady: boolean,
): boolean {
  switch (kind) {
    case 'managed_gateway':
      return gatewayEnabled;
    case 'claude_subscription':
      return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
    case 'anthropic_api_key':
      return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
    case 'codex_subscription':
      return Boolean(env.CODEX_AUTH_JSON?.trim() || env.OPENCODE_AUTH_JSON?.trim());
    case 'openai_api_key':
      return Boolean(env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim());
    case 'openai_compatible':
      return (
        env.CUSTOM_LLM_PROTOCOL?.trim().toLowerCase() === 'openai' &&
        Boolean(env.CUSTOM_LLM_BASE_URL?.trim())
      );
    case 'anthropic_compatible':
      return (
        env.CUSTOM_LLM_PROTOCOL?.trim().toLowerCase() === 'anthropic' &&
        Boolean(env.CUSTOM_LLM_BASE_URL?.trim())
      );
    case 'native_config':
      return nativeConfigReady;
  }
}

const AUTH_KIND_LABEL: Record<HarnessAuthKind, string> = {
  managed_gateway: 'the Kortix managed gateway',
  claude_subscription: 'a Claude subscription',
  anthropic_api_key: 'an Anthropic API key',
  codex_subscription: 'a ChatGPT/Codex subscription',
  openai_api_key: 'an OpenAI API key',
  openai_compatible: 'an OpenAI-compatible endpoint',
  anthropic_compatible: 'an Anthropic-compatible endpoint',
  native_config: 'a harness-native config',
};

/**
 * Deterministic credential-selection precedence — survives, re-hosted, from
 * `composer-capabilities.ts`'s `resolveActiveHarnessConnection` (verified
 * correct by every prior spec pass; not re-derived, only re-implemented over
 * a kind-presence set instead of a `HarnessConnection[]` list so this module
 * doesn't need that type). A configured managed route wins; with no managed
 * route, exactly one configured non-native/non-managed route may be adopted
 * (two or more require an explicit choice); native_config is the last
 * resort.
 */
function pickActiveKind(input: {
  configured: ReadonlySet<HarnessAuthKind>;
  compatible: readonly HarnessAuthKind[];
  explicit?: HarnessAuthKind | null;
  harnessLabel: string;
}): { kind: HarnessAuthKind } | { kind: null; reason: string } {
  const { configured, compatible, explicit, harnessLabel } = input;
  if (explicit) {
    if (!compatible.includes(explicit)) {
      return { kind: null, reason: `${explicit} is not compatible with ${harnessLabel}.` };
    }
    if (!configured.has(explicit)) {
      return { kind: null, reason: `Connect ${AUTH_KIND_LABEL[explicit]} before selecting it.` };
    }
    return { kind: explicit };
  }
  if (compatible.includes('managed_gateway') && configured.has('managed_gateway')) {
    return { kind: 'managed_gateway' };
  }
  const rest = compatible.filter(
    (kind) => kind !== 'native_config' && kind !== 'managed_gateway' && configured.has(kind),
  );
  if (rest.length === 1) return { kind: rest[0]! };
  if (rest.length > 1) {
    return { kind: null, reason: `Choose which ${harnessLabel} authentication connection to use.` };
  }
  if (compatible.includes('native_config') && configured.has('native_config')) {
    return { kind: 'native_config' };
  }
  return { kind: null, reason: `Connect a compatible ${harnessLabel} authentication route.` };
}

function noCredential(harness: HarnessId, reason: string): HarnessModelResolution {
  return {
    state: 'no_credential',
    harness,
    upstreamKind: null,
    credentialRef: null,
    ownsDefaultModel: HARNESSES[harness].ownsDefaultModel,
    models: [],
    default: null,
    reason,
  };
}

function expiredResolution(
  harness: HarnessId,
  credentialRef: CredentialRef,
  upstreamKind: UpstreamKind,
  reason: string,
): HarnessModelResolution {
  return {
    state: 'expired',
    harness,
    upstreamKind,
    credentialRef,
    ownsDefaultModel: HARNESSES[harness].ownsDefaultModel,
    models: [],
    default: null,
    reason,
  };
}

/**
 * Custom-endpoint and native-config catalogs aren't models.dev-conditioned —
 * they're the project's own declared configuration, never routed through the
 * gateway's runtime catalog (which knows nothing about a project's custom
 * base URL or a repo-declared native provider set). `native_config`'s list is
 * already narrowed: only providers whose env credential is ACTUALLY present
 * contribute models.
 */
function directOrCustomModels(kind: HarnessAuthKind, env: Record<string, string>): ResolvedModel[] {
  if (kind === 'openai_compatible' || kind === 'anthropic_compatible') {
    const id = env.CUSTOM_LLM_MODEL_ID?.trim();
    return id ? [{ id, name: id, provider: 'custom' }] : [];
  }
  if (kind === 'native_config') {
    return CATALOG.providers.flatMap((provider) => {
      const names = provider.env ?? [];
      if (!names.length || !names.every((name) => Boolean(env[name]?.trim()))) return [];
      return provider.models.map((model) => ({
        id: `${provider.id}/${model.id}`,
        name: model.name || model.id,
        provider: provider.id,
      }));
    });
  }
  return [];
}

/** `gpt-5.6-sol` → `GPT-5.6-Sol`; a readable display name derived from the bare
 *  advertised id so this module never hand-maintains a second name table. */
function codexModelDisplayName(id: string): string {
  return id
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-');
}

/**
 * The model set a connected Codex/ChatGPT subscription unlocks — the
 * ChatGPT-BACKEND advertised list (`codexModelIds()`, the SAME source the
 * `codex` harness and the composer pills use), NOT the gateway/models.dev
 * catalog. The subscription relay (`/router/codex-subscription`) forwards a
 * model id VERBATIM to the ChatGPT backend, which only accepts these BARE ids
 * (a gateway-style `openai/…`-prefixed id is rejected 400), so the ids stay
 * bare here — the provider tag (`openai-codex`, matching `codexDescriptor`)
 * carries the routing fact so no consumer parses the id. This is what makes a
 * catalog-driven harness (`ownsDefaultModel: false` — Pi) resolve to a real,
 * non-empty, subscription-correct list instead of falling through to the
 * gateway catalog (which knows nothing of the ChatGPT-backend model set) and
 * landing in `healthy_but_no_models`.
 */
function codexSubscriptionModels(): ResolvedModel[] {
  return codexModelIds().map((id) => ({
    id,
    name: codexModelDisplayName(id),
    provider: 'openai-codex',
  }));
}

/**
 * The narrowed, credential-conditioned, provider-tagged catalog for a
 * catalog-driven harness (`ownsDefaultModel === false` — OpenCode, and per
 * the 2026-07-21 Pi decision, Pi) whose active kind is `managed_gateway`,
 * `anthropic_api_key`, or `openai_api_key`. Reuses `projectPickerCatalog` —
 * the SAME conditioning `/model-picker` already applies (Step 1.1 of the
 * refactor plan) — so this module and that route never compute two
 * different "what can this project reach" answers.
 *
 * Folds in the real managed-route reachability probe that used to live in
 * the now-deleted `managedGatewayHasNothingToRouteTo`: a non-empty managed
 * lineup on the DEPLOYMENT says nothing about whether any of it is actually
 * servable for THIS account (missing transport credential, free-tier/
 * entitlement gate) — `probeManagedModelServable` is that check, injected
 * (rather than hard-importing `isModelServableForAccount`) so this stays
 * unit-testable without a DB, and wired to the SAME function every other
 * request-time caller already trusts in production.
 */
async function conditionedCatalogModels(input: {
  projectId: string;
  env: Record<string, string>;
  gatewayEnabled: boolean;
  freeModelsOnly: boolean;
  probeManagedModelServable: (modelId: string) => Promise<boolean>;
}): Promise<ResolvedModel[]> {
  const connectedEnvVars = new Set(Object.keys(input.env).map((name) => name.toUpperCase()));
  // Kortix-managed models are only ever reachable through the managed_gateway
  // route — a project that hasn't opted into it (the `llm_gateway` flag) has
  // no path to them at all, regardless of which OTHER BYOK connection is
  // active. `gatewayModelCatalog`'s `freeManagedOnly` option happens to be
  // the exact "exclude managed" toggle this needs (already used for the
  // free-tier-hides-managed case) — reused here, not re-derived, for the
  // "project never opted into the gateway" case too.
  const excludeManaged = !input.gatewayEnabled || input.freeModelsOnly;
  const catalog = gatewayModelCatalog(input.projectId, { freeManagedOnly: excludeManaged });
  const conditioned = projectPickerCatalog(catalog, connectedEnvVars, []);

  const managedIds = RUNTIME_MANAGED_MODELS.map((m) => m.id).filter((id) => id in conditioned);
  let managedRouteAlive = managedIds.length === 0;
  for (const id of managedIds) {
    // Short-circuit on the first real hit — the free-tier/entitlement gate
    // applies uniformly across every managed model, so one servable hit is
    // enough to know the route isn't dead; a missing transport credential
    // only affects models routed through that specific transport, so
    // "nothing works" still requires checking all of them.
    if (await input.probeManagedModelServable(id)) {
      managedRouteAlive = true;
      break;
    }
  }

  return Object.entries(conditioned)
    .filter(([, model]) => managedRouteAlive || model.provider !== 'kortix')
    .map(([id, model]) => ({
      id: id.includes('/') ? id : `kortix/${id}`,
      name: model.name || id,
      provider: model.provider || (id.includes('/') ? id.split('/')[0]! : 'kortix'),
    }));
}

export interface ResolveHarnessModelsInput {
  harness: HarnessId;
  projectId: string;
  accountId?: string;
  userId: string | null;
  /** The (agent-scoped) project secret env snapshot — fetched once by the
   *  caller (composer-capabilities.ts already needs it for other reasons),
   *  never re-fetched here. */
  env: Record<string, string>;
  gatewayEnabled: boolean;
  nativeConfigReady: boolean;
  explicit?: HarnessAuthKind | null;
  /** Injected for testability; defaults to the real Codex credential
   *  resolver (refresh-on-read, single-flight). */
  resolveCodex?: typeof resolveCodexCredential;
  /** Injected for testability; defaults to a real per-account servability
   *  probe wired to `isModelServableForAccount` (the SAME function every
   *  other request-time resolution path already trusts). */
  probeManagedModelServable?: (modelId: string) => Promise<boolean>;
}

async function defaultProbeManagedModelServable(input: {
  accountId?: string;
  userId: string | null;
  projectId: string;
  freeModelsOnly: boolean;
}): Promise<(modelId: string) => Promise<boolean>> {
  if (!input.accountId || !input.userId) {
    // No account context to probe against — degrade to "assume servable"
    // (the same degrade the deleted managedGatewayHasNothingToRouteTo used),
    // never fail closed for a caller that never had an account to check.
    return async () => true;
  }
  const { isModelServableForAccount } = await import('./default-model');
  const accountId = input.accountId;
  const userId = input.userId;
  return (modelId: string) =>
    isModelServableForAccount({
      userId,
      accountId,
      projectId: input.projectId,
      freeModelsOnly: input.freeModelsOnly,
      model: modelId,
    });
}

/**
 * THE resolution function (concept 1.4). Given a project, a harness, and
 * (optionally) an explicit credential choice, returns the one closed-state
 * answer to "which models are available, which is the default, and can a
 * session start." See the module doc comment for the state union's
 * construction guarantee.
 */
export async function resolveHarnessModels(
  input: ResolveHarnessModelsInput,
): Promise<HarnessModelResolution> {
  const descriptor = HARNESSES[input.harness];
  const compatible = descriptor.authKinds;
  const configured = new Set(
    compatible.filter((kind) =>
      isCredentialConfigured(kind, input.env, input.gatewayEnabled, input.nativeConfigReady),
    ),
  );

  if (configured.size === 0) {
    return noCredential(
      input.harness,
      `Connect a compatible ${descriptor.label} authentication route.`,
    );
  }

  const picked = pickActiveKind({
    configured,
    compatible,
    explicit: input.explicit,
    harnessLabel: descriptor.label,
  });
  if (!picked.kind) return noCredential(input.harness, picked.reason);
  const kind = picked.kind;
  const credentialRef: CredentialRef = { kind, scope: 'shared' };
  const upstreamKind = upstreamKindForCredential(kind);

  if (kind === 'codex_subscription') {
    const resolveCodex = input.resolveCodex ?? resolveCodexCredential;
    try {
      const credential = await resolveCodex(input.projectId, input.userId ?? '');
      if (!credential) {
        return noCredential(
          input.harness,
          `Connect ${AUTH_KIND_LABEL.codex_subscription} to use this model.`,
        );
      }
    } catch (err) {
      if (err instanceof CodexRefreshError) {
        return expiredResolution(
          input.harness,
          credentialRef,
          upstreamKind,
          'Your Codex session has expired or was revoked — reconnect Codex in project settings.',
        );
      }
      throw err;
    }
  }

  if (descriptor.ownsDefaultModel) {
    return {
      state: 'ready',
      harness: input.harness,
      upstreamKind,
      credentialRef,
      ownsDefaultModel: true,
      models: [],
      default: null,
      reason: null,
    };
  }

  const freeModelsOnly =
    input.accountId && config.KORTIX_BILLING_INTERNAL_ENABLED
      ? accountIsFreeTierForModels(await getCachedAccountTier(input.accountId))
      : false;

  const models =
    kind === 'codex_subscription'
      ? // Reached only for a catalog-driven harness (Pi) — the `codex` harness
        // (`ownsDefaultModel: true`) already returned `ready` with an empty
        // list above and advertises its own models over ACP. A Codex
        // subscription's models are the ChatGPT-backend set, never the gateway
        // catalog, so this bypasses `conditionedCatalogModels` entirely.
        codexSubscriptionModels()
      : kind === 'openai_compatible' || kind === 'anthropic_compatible' || kind === 'native_config'
        ? directOrCustomModels(kind, input.env)
        : await conditionedCatalogModels({
            projectId: input.projectId,
            env: input.env,
            gatewayEnabled: input.gatewayEnabled,
            freeModelsOnly,
            probeManagedModelServable:
              input.probeManagedModelServable ??
              (await defaultProbeManagedModelServable({
                accountId: input.accountId,
                userId: input.userId,
                projectId: input.projectId,
                freeModelsOnly,
              })),
          });

  if (models.length === 0) {
    return {
      state: 'healthy_but_no_models',
      harness: input.harness,
      upstreamKind,
      credentialRef,
      ownsDefaultModel: false,
      models: [],
      default: null,
      reason:
        'No model is reachable with the connected credentials for this project — connect a model provider to start a session.',
    };
  }

  const auto = models.find((model) => model.id === 'kortix/auto');
  return {
    state: 'ready',
    harness: input.harness,
    upstreamKind,
    credentialRef,
    ownsDefaultModel: false,
    models,
    default: auto ? auto.id : models[0]!.id,
    reason: null,
  };
}
