import { describe, expect, it } from 'bun:test';
import {
  AUTH_PROVIDERS_PUBLIC,
  accountDoorProviders,
  findAuthProviderPublic,
} from './auth-providers';
import { HARNESSES, HARNESS_IDS, compatibleHarnessesFor } from './harnesses';

describe('AUTH_PROVIDERS_PUBLIC', () => {
  it('lists exactly the two account-door providers with a real subscription flow', () => {
    expect(AUTH_PROVIDERS_PUBLIC.map((p) => p.id).sort()).toEqual(['anthropic', 'openai']);
    for (const provider of AUTH_PROVIDERS_PUBLIC) {
      expect(provider.door).toBe('account');
    }
  });

  it('every entry produces a HarnessAuthKind that some harness actually accepts', () => {
    for (const provider of AUTH_PROVIDERS_PUBLIC) {
      expect(compatibleHarnessesFor(provider.producesAuthKind).length).toBeGreaterThan(0);
    }
  });

  it('Anthropic produces claude_subscription, gated on the one-click flip, paste-token-first on web', () => {
    const anthropic = findAuthProviderPublic('anthropic', 'account');
    expect(anthropic?.producesAuthKind).toBe('claude_subscription');
    expect(anthropic?.gatedBehind).toBe('anthropic_oauth_oneclick');
    expect(anthropic?.flows.web).toEqual(['paste-token']);
    expect(anthropic?.flows.cli).toEqual(['browser-oauth', 'paste-token']);
  });

  it('OpenAI/Codex produces codex_subscription, ungated, device-code-only on web', () => {
    const codex = findAuthProviderPublic('openai', 'account');
    expect(codex?.producesAuthKind).toBe('codex_subscription');
    expect(codex?.gatedBehind).toBeUndefined();
    expect(codex?.flows.web).toEqual(['device-code']);
    expect(codex?.flows.cli).toEqual(['browser-oauth', 'device-code']);
  });

  it('findAuthProviderPublic is door-scoped — an unknown door returns undefined even for a known id', () => {
    expect(findAuthProviderPublic('anthropic', 'api-key')).toBeUndefined();
    expect(findAuthProviderPublic('does-not-exist', 'account')).toBeUndefined();
  });

  it('accountDoorProviders returns every entry (all entries are account-door today)', () => {
    expect(accountDoorProviders().length).toBe(AUTH_PROVIDERS_PUBLIC.length);
  });

  it('every producesAuthKind actually appears on the harness it claims compatibility with', () => {
    for (const provider of AUTH_PROVIDERS_PUBLIC) {
      const harnesses = compatibleHarnessesFor(provider.producesAuthKind);
      for (const harnessId of harnesses) {
        expect(HARNESSES[harnessId].authKinds).toContain(provider.producesAuthKind);
      }
    }
  });

  it('never invents a HarnessAuthKind outside the closed union HARNESS_IDS actually use', () => {
    const usedKinds = new Set(HARNESS_IDS.flatMap((id) => HARNESSES[id].authKinds));
    for (const provider of AUTH_PROVIDERS_PUBLIC) {
      expect(usedKinds.has(provider.producesAuthKind)).toBe(true);
    }
  });
});
