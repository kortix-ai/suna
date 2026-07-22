/**
 * The unified auth-provider registry — docs/specs/2026-07-22-unified-auth-
 * gateway.md §3.2 (Step 0). Answers "how does a user connect provider X" —
 * the layer ABOVE `credentials/*.ts` (which answers "is a stored connection
 * currently usable") and `resolution/harness-models.ts` (which answers "can
 * this harness start"). One direction of dependency: `auth → credentials →
 * (consumed by) resolution`. This module does not touch either of those.
 *
 * Every entry's `producesAuthKind` is one of the EXISTING 8 `HarnessAuthKind`
 * values (`@kortix/shared/harnesses`) — no new taxonomy, per the spec's non-
 * negotiable and this task's brief. `registry.test.ts` pins the round-trip:
 * every `HarnessAuthKind` that actually gates some harness (i.e. appears in
 * `HARNESSES[*].authKinds`) has at least one entry here, except
 * `managed_gateway` (Kortix's own included route — not something a user
 * "connects" through this UI, so it deliberately has NO row) and
 * `native_config` (a committed config file, not connectable via this UI
 * either).
 *
 * ── Deviation from the spec's literal Step 0 entry list (flagged loudly) ──
 * §10.3 Step 0 says entries should include "every existing `@kortix/llm-
 * catalog` provider (api-key, derived not hand-authored)". Read literally,
 * that would mean ~165 registry rows (OpenRouter, Google, Groq, DeepSeek,
 * Mistral, Bedrock, …) each carrying a `producesAuthKind`. Tracing the ACTUAL
 * mechanism (`resolution/harness-models.ts`'s `conditionedCatalogModels`)
 * shows this doesn't hold: those providers' keys widen the
 * `managed_gateway`-conditioned catalog for OpenCode/Pi — they do not
 * individually gate a distinct `HarnessAuthKind` the way Anthropic's and
 * OpenAI's OWN keys do (which power Claude Code's/Codex's *direct*,
 * non-gateway `anthropic_api_key`/`openai_api_key` paths). No such kind
 * exists for "a Groq key" or "a Bedrock key" today, and inventing one would
 * violate the "map onto the EXISTING enum" non-negotiable; mapping them onto
 * `managed_gateway` would violate the registry.test round-trip rule above
 * (`managed_gateway` gets no row) AND misrepresent `isCredentialConfigured`'s
 * actual `managed_gateway` check (a project flag, not a per-provider key).
 * So: only the two catalog providers that DO gate a real, distinct
 * `HarnessAuthKind` (Anthropic, OpenAI) get registry rows here, generated
 * from `@kortix/llm-catalog` per the spec's "derived not hand-authored"
 * instruction. Every other catalog provider is exposed via the separate,
 * clearly-non-`AuthProviderDescriptor` `deriveCatalogByokEntries()` below —
 * connect-only metadata for a future web/CLI surface to render the long BYOK
 * tail without fabricating a registry entry that can't type-check against
 * `HarnessAuthKind` and can't be resolved by anything downstream. Flagged
 * for the owner / the next wave (routes/web) to confirm before Step 5 renders
 * off this — see the task report for the full reasoning.
 */
import { CATALOG, primaryAuthEnvVars } from '@kortix/llm-catalog';
import {
  AUTH_PROVIDERS_PUBLIC,
  type AuthDoor,
  type AuthFlow,
  findAuthProviderPublic,
} from '@kortix/shared/auth-providers';
import { HARNESSES, HARNESS_IDS, type HarnessAuthKind } from '@kortix/shared/harnesses';

import { CODEX_CLIENT_ID, OPENAI_AUTH_BASE } from '../credentials/codex-core';

export type { AuthDoor, AuthFlow };

export interface OAuthClientConfig {
  clientId: string;
  /** Absent for device-code-only providers (they have no /authorize endpoint). */
  authorizeUrl?: string;
  tokenUrl: string;
  /** Present iff `'device-code'` is one of this provider's flows. */
  deviceCodeUrl?: string;
  scopes: string[];
  /** True for browser-oauth; irrelevant (but harmless) for pure device-code. */
  pkce: boolean;
  /** CLI-only — e.g. `http://localhost:53692/callback`. Web never uses this (spec §6.1). */
  cliRedirectUri: string;
  cliRedirectPort: number;
}

export interface AuthProviderDescriptor {
  /** Matches `@kortix/llm-catalog`'s catalog provider id where one exists. */
  id: string;
  label: string;
  door: AuthDoor;
  /** The ONE existing `HarnessAuthKind` this entry maps onto — no new taxonomy. */
  producesAuthKind: HarnessAuthKind;
  flows: {
    web: AuthFlow[];
    cli: AuthFlow[];
  };
  /** Present iff `door === 'account'`. */
  oauth?: OAuthClientConfig;
  /** Present iff `door === 'api-key'`; sourced from `@kortix/llm-catalog`'s `primaryAuthEnvVars`. */
  apiKeyEnvVars?: string[];
  refresh: 'refresh-token' | 'none';
  /** The one flag-gated flow (spec §7, §11#1) — off by default, never silently enabled. */
  gatedBehind?: 'anthropic_oauth_oneclick';
  /** Provider-specific step required after login completes, beyond storing the credential. */
  postAuthSteps?: 'copilot-enable-models';
  docsUrl?: string;
}

// ─── Anthropic OAuth client config ──────────────────────────────────────────
// Ported verbatim from pi/packages/ai/src/auth/oauth/anthropic.ts (read in
// full 2026-07-22, github.com/earendil-works/pi). Pi base64-obscures the
// client id in its BROWSER-bundled source; this module is server-only, so
// it's kept in plain decoded form (`9d1c250a-e61b-44d9-88ed-5944d1962f5e` —
// confirmed byte-for-byte against the decoded value, matches the owner's
// citation).
const ANTHROPIC_OAUTH: OAuthClientConfig = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  // NOTE: token exchange goes to platform.claude.com, NOT claude.ai — the
  // authorize/token hosts differ (pi anthropic.ts:30-31).
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  scopes: [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
  ],
  pkce: true,
  cliRedirectUri: 'http://localhost:53692/callback',
  cliRedirectPort: 53692,
};

// ─── OpenAI Codex OAuth client config ───────────────────────────────────────
// Ported from pi/packages/ai/src/auth/oauth/openai-codex.ts (read in full).
// CLIENT_ID/OPENAI_AUTH_BASE are re-imported from `../credentials/codex-
// core.ts` rather than re-declared — that module already authored these two
// constants for the shipped refresh path (`buildRefreshBody`), and
// duplicating them here would be exactly the "two hand-maintained values that
// must agree" drift risk this whole spec exists to kill.
const OPENAI_CODEX_OAUTH: OAuthClientConfig = {
  clientId: CODEX_CLIENT_ID,
  authorizeUrl: `${OPENAI_AUTH_BASE}/oauth/authorize`,
  tokenUrl: `${OPENAI_AUTH_BASE}/oauth/token`,
  deviceCodeUrl: `${OPENAI_AUTH_BASE}/api/accounts/deviceauth/usercode`,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  pkce: true,
  cliRedirectUri: 'http://localhost:1455/auth/callback',
  cliRedirectPort: 1455,
};

function apiKeyEntryFromCatalog(input: {
  catalogId: string;
  label: string;
  producesAuthKind: HarnessAuthKind;
}): AuthProviderDescriptor {
  const catalogProvider = CATALOG.providers.find((p) => p.id === input.catalogId);
  return {
    id: input.catalogId,
    label: input.label,
    door: 'api-key',
    producesAuthKind: input.producesAuthKind,
    flows: { web: ['paste-api-key'], cli: ['paste-api-key'] },
    apiKeyEnvVars: catalogProvider ? primaryAuthEnvVars(catalogProvider) : [],
    refresh: 'none',
  };
}

function oauthEntry(providerId: 'anthropic' | 'openai'): AuthProviderDescriptor {
  const publicEntry = findAuthProviderPublic(providerId, 'account');
  if (!publicEntry) {
    throw new Error(
      `auth-providers.ts is missing the public entry for "${providerId}" — keep the two tables in sync`,
    );
  }
  if (providerId === 'anthropic') {
    return {
      id: publicEntry.id,
      label: publicEntry.label,
      door: publicEntry.door,
      producesAuthKind: publicEntry.producesAuthKind,
      flows: publicEntry.flows,
      oauth: ANTHROPIC_OAUTH,
      // No refresh call in Tier A — unverified whether a `claude setup-
      // token`-minted token has any refresh mechanism at all (spec §5.2).
      refresh: 'none',
      gatedBehind: publicEntry.gatedBehind,
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup-token',
    };
  }
  return {
    id: publicEntry.id,
    label: publicEntry.label,
    door: publicEntry.door,
    producesAuthKind: publicEntry.producesAuthKind,
    flows: publicEntry.flows,
    oauth: OPENAI_CODEX_OAUTH,
    refresh: 'refresh-token',
    gatedBehind: publicEntry.gatedBehind,
  };
}

/**
 * The full server-side registry — every connectable auth-provider door with
 * a real, existing `HarnessAuthKind`. See this module's doc comment for why
 * the long BYOK catalog tail is NOT included here.
 */
export const AUTH_PROVIDERS: readonly AuthProviderDescriptor[] = [
  oauthEntry('anthropic'),
  apiKeyEntryFromCatalog({
    catalogId: 'anthropic',
    label: 'Anthropic',
    producesAuthKind: 'anthropic_api_key',
  }),
  oauthEntry('openai'),
  apiKeyEntryFromCatalog({
    catalogId: 'openai',
    label: 'OpenAI',
    producesAuthKind: 'openai_api_key',
  }),
  {
    // Not a catalog provider — the generic "OpenAI-compatible REST" custom
    // endpoint already shipped (`composer-capabilities.ts`'s
    // `CONNECTION_LABELS.openai_compatible`, unchanged by this document).
    // `apiKeyEnvVars` names the fields the existing custom-endpoint form
    // collects (`CUSTOM_LLM_PROTOCOL`/`CUSTOM_LLM_BASE_URL`/
    // `CUSTOM_LLM_MODEL_ID`), not a single provider's API key — kept as one
    // registry row rather than skipped so `openai_compatible` (which DOES
    // appear in `HARNESSES.opencode.authKinds`/`HARNESSES.pi.authKinds`) has
    // a producer, per this module's round-trip rule.
    id: 'openai-compatible-endpoint',
    label: 'OpenAI-compatible REST',
    door: 'api-key',
    producesAuthKind: 'openai_compatible',
    flows: { web: ['paste-api-key'], cli: ['paste-api-key'] },
    apiKeyEnvVars: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_MODEL_ID'],
    refresh: 'none',
  },
  {
    // Parked/unreachable today — `compatibleHarnessesFor('anthropic_compatible')`
    // is empty (no harness's `authKinds` lists it, per `harnesses.ts`'s own
    // comment and `composer-capabilities.ts`'s `CONNECTION_LABELS` entry).
    // Kept as a registry row for data completeness (the credential TYPE and
    // its plumbing still exist) but not required by, and not counted toward,
    // this module's round-trip coverage assertion.
    id: 'anthropic-compatible-endpoint',
    label: 'Anthropic-compatible REST',
    door: 'api-key',
    producesAuthKind: 'anthropic_compatible',
    flows: { web: ['paste-api-key'], cli: ['paste-api-key'] },
    apiKeyEnvVars: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_MODEL_ID'],
    refresh: 'none',
  },
];

export function findAuthProvider(id: string, door: AuthDoor): AuthProviderDescriptor | undefined {
  return AUTH_PROVIDERS.find((provider) => provider.id === id && provider.door === door);
}

export function authProvidersForKind(kind: HarnessAuthKind): readonly AuthProviderDescriptor[] {
  return AUTH_PROVIDERS.filter((provider) => provider.producesAuthKind === kind);
}

/**
 * `HarnessAuthKind` values that actually gate some harness today (appear in
 * some `HARNESSES[*].authKinds`) MINUS `managed_gateway`/`native_config`,
 * which deliberately have no registry row (see this module's doc comment).
 * `registry.test.ts`'s load-bearing assertion: every one of these has
 * `authProvidersForKind(kind).length > 0`.
 */
export function connectableAuthKinds(): HarnessAuthKind[] {
  const used = new Set<HarnessAuthKind>(HARNESS_IDS.flatMap((id) => HARNESSES[id].authKinds));
  used.delete('managed_gateway');
  used.delete('native_config');
  return [...used];
}

// ─── The long BYOK catalog tail — connect-only, NOT an AuthProviderDescriptor ──
//
// See this module's doc comment for why these can't type-check as
// `AuthProviderDescriptor` (no existing `HarnessAuthKind` fits "a Groq key").
// Deliberately excluded from `AUTH_PROVIDERS`/`connectableAuthKinds()`'s
// coverage rule; exists only so a future web/CLI surface can still render
// the long "OpenRouter · Google · Groq · …" tail (spec §9.1's wireframe)
// without fabricating a registry entry that lies about what it produces.
export interface CatalogByokProvider {
  id: string;
  label: string;
  apiKeyEnvVars: string[];
}

const REGISTRY_OWNED_CATALOG_IDS = new Set(['anthropic', 'openai']);

export function deriveCatalogByokEntries(): CatalogByokProvider[] {
  return CATALOG.providers
    .filter((provider) => !REGISTRY_OWNED_CATALOG_IDS.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      label: provider.name,
      apiKeyEnvVars: primaryAuthEnvVars(provider),
    }))
    .filter((entry) => entry.apiKeyEnvVars.length > 0);
}
