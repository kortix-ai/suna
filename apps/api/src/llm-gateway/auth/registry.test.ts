import { describe, expect, it } from 'bun:test';
import { CREDENTIAL_CUSTODY, HARNESSES, HARNESS_IDS } from '@kortix/shared/harnesses';

import {
  AUTH_PROVIDERS,
  authProvidersForKind,
  connectableAuthKinds,
  deriveCatalogByokEntries,
  findAuthProvider,
} from './registry';

describe('AUTH_PROVIDERS — round-trip against HARNESSES[*].authKinds', () => {
  it('every connectable HarnessAuthKind (excluding managed_gateway/native_config) has >=1 producer', () => {
    for (const kind of connectableAuthKinds()) {
      expect(authProvidersForKind(kind).length).toBeGreaterThan(0);
    }
  });

  it('managed_gateway gets NO registry row — it is Kortix\'s own included route, not user-connectable', () => {
    expect(authProvidersForKind('managed_gateway')).toEqual([]);
  });

  it('native_config gets NO registry row — a committed config file, not connectable via this UI', () => {
    expect(authProvidersForKind('native_config')).toEqual([]);
  });

  it('connectableAuthKinds excludes managed_gateway and native_config by construction', () => {
    expect(connectableAuthKinds()).not.toContain('managed_gateway');
    expect(connectableAuthKinds()).not.toContain('native_config');
  });

  it('every entry\'s producesAuthKind is a kind some harness declares, except the parked anthropic_compatible row', () => {
    const declared = new Set(HARNESS_IDS.flatMap((id) => HARNESSES[id].authKinds));
    for (const provider of AUTH_PROVIDERS) {
      if (provider.producesAuthKind === 'anthropic_compatible') continue; // parked, see harnesses.ts's own comment
      expect(declared.has(provider.producesAuthKind)).toBe(true);
    }
  });

  it('every entry carries a valid CREDENTIAL_CUSTODY verdict for its produced kind', () => {
    for (const provider of AUTH_PROVIDERS) {
      expect(CREDENTIAL_CUSTODY[provider.producesAuthKind]).toBeDefined();
    }
  });
});

describe('AUTH_PROVIDERS — per-entry shape', () => {
  it('Anthropic account door: claude_subscription, gated browser-oauth, sanctioned paste-token default on web', () => {
    const anthropic = findAuthProvider('anthropic', 'account');
    expect(anthropic?.producesAuthKind).toBe('claude_subscription');
    expect(anthropic?.gatedBehind).toBe('anthropic_oauth_oneclick');
    expect(anthropic?.flows.web).toEqual(['paste-token']);
    expect(anthropic?.refresh).toBe('none');
    expect(anthropic?.oauth?.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(anthropic?.oauth?.authorizeUrl).toBe('https://claude.ai/oauth/authorize');
    expect(anthropic?.oauth?.tokenUrl).toBe('https://platform.claude.com/v1/oauth/token');
    expect(anthropic?.oauth?.cliRedirectPort).toBe(53692);
    expect(anthropic?.oauth?.pkce).toBe(true);
  });

  it('OpenAI/Codex account door: codex_subscription, ungated, refresh-token, browser-first on CLI', () => {
    const codex = findAuthProvider('openai', 'account');
    expect(codex?.producesAuthKind).toBe('codex_subscription');
    expect(codex?.gatedBehind).toBeUndefined();
    expect(codex?.refresh).toBe('refresh-token');
    expect(codex?.flows.cli).toEqual(['browser-oauth', 'device-code']);
    expect(codex?.flows.web).toEqual(['device-code']);
    expect(codex?.oauth?.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(codex?.oauth?.deviceCodeUrl).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(codex?.oauth?.cliRedirectPort).toBe(1455);
  });

  it('Anthropic api-key door: anthropic_api_key, derived envVars from the catalog, no oauth config', () => {
    const anthropicKey = findAuthProvider('anthropic', 'api-key');
    expect(anthropicKey?.producesAuthKind).toBe('anthropic_api_key');
    expect(anthropicKey?.apiKeyEnvVars).toEqual(['ANTHROPIC_API_KEY']);
    expect(anthropicKey?.oauth).toBeUndefined();
  });

  it('OpenAI api-key door: openai_api_key, derived envVars from the catalog', () => {
    const openaiKey = findAuthProvider('openai', 'api-key');
    expect(openaiKey?.producesAuthKind).toBe('openai_api_key');
    expect(openaiKey?.apiKeyEnvVars).toEqual(['OPENAI_API_KEY']);
  });

  it('openai_compatible/anthropic_compatible custom-endpoint rows exist and are api-key-door', () => {
    const openaiCompatible = authProvidersForKind('openai_compatible')[0];
    expect(openaiCompatible?.door).toBe('api-key');
    expect(openaiCompatible?.apiKeyEnvVars).toContain('CUSTOM_LLM_BASE_URL');

    const anthropicCompatible = authProvidersForKind('anthropic_compatible')[0];
    expect(anthropicCompatible?.door).toBe('api-key');
  });

  it('findAuthProvider is door-scoped', () => {
    expect(findAuthProvider('anthropic', 'account')?.producesAuthKind).toBe('claude_subscription');
    expect(findAuthProvider('anthropic', 'api-key')?.producesAuthKind).toBe('anthropic_api_key');
    expect(findAuthProvider('nonexistent-provider', 'account')).toBeUndefined();
  });
});

describe('custody enforcement — the registry cannot misrepresent a direct-only credential', () => {
  it('claude_subscription (direct-only) is never marked refresh-token in Tier A', () => {
    // Custody itself is enforced downstream (assertRelayEligible in
    // resolution/harness-models.ts, unchanged); this pins the registry's own
    // half of the guarantee — it never claims a network-refreshable OAuth
    // token for a credential Anthropic's policy forbids relaying at all.
    const anthropic = findAuthProvider('anthropic', 'account');
    expect(CREDENTIAL_CUSTODY.claude_subscription).toBe('direct-only');
    expect(anthropic?.refresh).toBe('none');
  });

  it('every produced kind resolves to a real CREDENTIAL_CUSTODY verdict — no entry can reference an unknown kind', () => {
    for (const provider of AUTH_PROVIDERS) {
      expect(['direct-only', 'relay-eligible']).toContain(CREDENTIAL_CUSTODY[provider.producesAuthKind]);
    }
  });
});

describe('deriveCatalogByokEntries — the long BYOK tail, explicitly NOT AuthProviderDescriptor rows', () => {
  it('excludes the two catalog ids the registry already owns', () => {
    const ids = deriveCatalogByokEntries().map((entry) => entry.id);
    expect(ids).not.toContain('anthropic');
    expect(ids).not.toContain('openai');
  });

  it('returns a large set of other real catalog providers, each with at least one env var', () => {
    const entries = deriveCatalogByokEntries();
    expect(entries.length).toBeGreaterThan(50);
    for (const entry of entries) {
      expect(entry.apiKeyEnvVars.length).toBeGreaterThan(0);
    }
    expect(entries.map((e) => e.id)).toContain('google');
    expect(entries.map((e) => e.id)).toContain('openrouter');
  });
});
