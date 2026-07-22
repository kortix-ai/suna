import { describe, expect, test } from 'bun:test';
import { HARNESSES, HARNESS_IDS, type HarnessAuthKind } from '@kortix/shared/harnesses';

import {
  CredentialCustodyViolationError,
  type HarnessModelResolution,
  assertRelayEligible,
  isCredentialConfigured,
  resolveHarnessModels,
  upstreamKindForCredential,
} from './harness-models';

// Every test below omits `accountId` unless a test specifically needs it —
// with no account context, the managed-route probe degrades to "assume
// servable" and the free-tier lookup is skipped entirely, so these tests
// never touch a real DB (same convention as
// composer-capabilities-experimental-harnesses.test.ts).

describe('resolveHarnessModels — the closed state union', () => {
  test('no_credential: zero compatible credentials configured', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {},
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('no_credential');
    expect(result.credentialRef).toBeNull();
    expect(result.upstreamKind).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.default).toBeNull();
    expect(result.reason).not.toBeNull();
  });

  test('no_credential: explicit connection kind is not compatible with the harness', async () => {
    const result = await resolveHarnessModels({
      harness: 'claude',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub' },
      gatewayEnabled: true,
      nativeConfigReady: false,
      explicit: 'managed_gateway',
    });
    expect(result.state).toBe('no_credential');
    expect(result.reason).toContain('not compatible');
  });

  test('no_credential: explicit connection kind is compatible but not configured', async () => {
    const result = await resolveHarnessModels({
      harness: 'claude',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {},
      gatewayEnabled: false,
      nativeConfigReady: false,
      explicit: 'anthropic_api_key',
    });
    expect(result.state).toBe('no_credential');
    expect(result.reason).toContain('Connect');
  });

  test('no_credential: two ready BYOK connections with no explicit choice is ambiguous, not ready', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key', OPENAI_API_KEY: 'o-key' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('no_credential');
    expect(result.reason).toContain('Choose');
  });

  test('expired: codex_subscription is present but the refresh fails', async () => {
    const result = await resolveHarnessModels({
      harness: 'codex',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{"openai":{}}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      resolveCodex: async () => {
        const { CodexRefreshError } = await import('../credentials/codex');
        throw new CodexRefreshError('revoked');
      },
    });
    expect(result.state).toBe('expired');
    expect(result.credentialRef).toEqual({ kind: 'codex_subscription', scope: 'shared' });
    expect(result.reason).toContain('Codex');
  });

  test('no_credential: codex_subscription row is present but resolves to nothing usable', async () => {
    const result = await resolveHarnessModels({
      harness: 'codex',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      resolveCodex: async () => null,
    });
    expect(result.state).toBe('no_credential');
  });

  test('ready: codex_subscription resolves — ownsDefaultModel harness exposes NO catalog', async () => {
    const result = await resolveHarnessModels({
      harness: 'codex',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      resolveCodex: async () => ({ access: 'token', accountId: undefined }),
    });
    expect(result.state).toBe('ready');
    expect(result.ownsDefaultModel).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.default).toBeNull();
    expect(result.upstreamKind).toBe('gateway'); // codex_subscription is relay-eligible
  });

  test('ready: pi + codex_subscription — the ChatGPT-backend model set (NOT the gateway catalog), bare ids, provider-tagged', async () => {
    // The 2026-07-22 Codex-subscription widening. Pi is catalog-driven
    // (ownsDefaultModel: false), so unlike the `codex` harness it does NOT
    // return an empty list — it must resolve to the models a Codex
    // subscription actually unlocks: the ChatGPT-backend advertised set, never
    // the gateway/models.dev catalog (which knows nothing of them). The relay
    // forwards a model id verbatim to the ChatGPT backend, so the ids must be
    // BARE (no `openai/`/`kortix/` prefix), and the default must be the first
    // advertised value.
    const { codexModelIds } = await import('../models/codex-models');
    const result = await resolveHarnessModels({
      harness: 'pi',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{"openai":{}}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      resolveCodex: async () => ({ access: 'token', accountId: undefined }),
    });
    expect(result.state).toBe('ready');
    expect(result.ownsDefaultModel).toBe(false);
    expect(result.credentialRef).toEqual({ kind: 'codex_subscription', scope: 'shared' });
    expect(result.upstreamKind).toBe('gateway'); // codex_subscription is relay-eligible
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.map((m) => m.id)).toEqual(codexModelIds());
    // Bare, ChatGPT-accepted ids — never a gateway-prefixed id the backend 400s.
    for (const model of result.models) {
      expect(model.provider).toBe('openai-codex');
      expect(model.id.includes('/')).toBe(false);
    }
    expect(result.default).toBe(codexModelIds()[0]);
    expect(result.default).toBe('gpt-5.6-sol');
  });

  test('ready: opencode + codex_subscription — the ChatGPT-backend model set in the gateway `codex/*` namespace (OpenCode rides the AI-SDK gateway codex path, not the raw relay)', async () => {
    // OpenCode is catalog-driven (ownsDefaultModel: false) like Pi, so a
    // connected Codex subscription resolves to the ChatGPT-backend advertised
    // set — never the gateway catalog. But OpenCode reaches Codex through the
    // AI-SDK gateway's `codex/*` chat-completions path (its normal managed
    // provider, model set swapped), which routes on the `codex/` prefix — so
    // unlike Pi's BARE ids (raw relay, forwarded verbatim), OpenCode's ids carry
    // the canonical `codex/<id>` gateway grammar. The set is otherwise the same
    // list, provider-tagged `openai-codex`.
    const { codexModelIds } = await import('../models/codex-models');
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{"openai":{}}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      explicit: 'codex_subscription',
      resolveCodex: async () => ({ access: 'token', accountId: undefined }),
    });
    expect(result.state).toBe('ready');
    expect(result.ownsDefaultModel).toBe(false);
    expect(result.credentialRef).toEqual({ kind: 'codex_subscription', scope: 'shared' });
    expect(result.upstreamKind).toBe('gateway'); // codex_subscription is relay-eligible
    expect(result.models.map((m) => m.id)).toEqual(codexModelIds().map((id) => `codex/${id}`));
    for (const model of result.models) {
      expect(model.provider).toBe('openai-codex');
      expect(model.id.startsWith('codex/')).toBe(true);
    }
    expect(result.default).toBe('codex/gpt-5.6-sol');
  });

  test('pi + codex_subscription whose credential resolves to nothing usable is no_credential, never a bogus catalog', async () => {
    const result = await resolveHarnessModels({
      harness: 'pi',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CODEX_AUTH_JSON: '{}' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      resolveCodex: async () => null,
    });
    expect(result.state).toBe('no_credential');
    expect(result.models).toEqual([]);
  });

  test('ready: claude via anthropic_api_key (not subscription) still owns its default, no catalog', async () => {
    const result = await resolveHarnessModels({
      harness: 'claude',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('ready');
    expect(result.ownsDefaultModel).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.upstreamKind).toBe('gateway'); // anthropic_api_key is relay-eligible
  });

  test('ready: claude subscription is direct-only at the upstream-kind level', async () => {
    const result = await resolveHarnessModels({
      harness: 'claude',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sub' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('ready');
    expect(result.credentialRef?.kind).toBe('claude_subscription');
    expect(result.upstreamKind).toBe('direct');
  });

  test('healthy_but_no_models: managed_gateway flag on, nothing reachable — the exact bug this module exists to make unrepresentable', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {},
      gatewayEnabled: true,
      nativeConfigReady: false,
      // Force "nothing servable" deterministically — this deployment's own
      // KORTIX_MANAGED_PROVIDER_ENABLED/managed lineup config is irrelevant
      // to what this test proves (a dead managed route + zero BYOK fallback
      // must never resolve `ready`).
      probeManagedModelServable: async () => false,
    });
    expect(result.state).toBe('healthy_but_no_models');
    expect(result.models).toEqual([]);
    expect(result.credentialRef).toEqual({ kind: 'managed_gateway', scope: 'shared' });
    expect(result.reason).not.toBeNull();
  });

  test('ready: managed_gateway flag on and the managed route proves alive — kortix/auto is offered as the default', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {},
      gatewayEnabled: true,
      nativeConfigReady: false,
      probeManagedModelServable: async () => true,
    });
    expect(result.state).toBe('ready');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => m.provider === 'kortix')).toBe(true);
  });

  test('a BYOK connection never leaks Kortix-managed models when the project has NOT opted into the gateway flag', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key' },
      gatewayEnabled: false,
      nativeConfigReady: false,
      // If this were ever called, the managed-exclusion gate below is broken —
      // it must never even reach the probe when gatewayEnabled is false.
      probeManagedModelServable: async () => {
        throw new Error('must not probe managed reachability when the gateway flag is off');
      },
    });
    expect(result.state).toBe('ready');
    expect(result.models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  test('ready + narrowing: a project with ONLY ANTHROPIC_API_KEY gets ONLY anthropic-reachable, provider-tagged models', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('ready');
    expect(result.models.length).toBeGreaterThan(0);
    // The unconditioned catalog is ~4,900 entries across every provider —
    // narrowing must keep this bounded to what's actually reachable.
    expect(result.models.length).toBeLessThan(50);
    for (const model of result.models) {
      expect(model.provider).toBe('anthropic');
      expect(model.id.startsWith('anthropic/')).toBe(true);
    }
  });

  test("Pi's catalog-driven resolution (2026-07-21 decision): same narrowing as OpenCode, not harness_default", async () => {
    expect(HARNESSES.pi.ownsDefaultModel).toBe(false);
    const result = await resolveHarnessModels({
      harness: 'pi',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('ready');
    expect(result.ownsDefaultModel).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  test('healthy_but_no_models for Pi mirrors OpenCode — same resolver, same narrowing, no harness-specific carve-out', async () => {
    const result = await resolveHarnessModels({
      harness: 'pi',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {},
      gatewayEnabled: true,
      nativeConfigReady: false,
      probeManagedModelServable: async () => false,
    });
    expect(result.state).toBe('healthy_but_no_models');
  });

  test('ready: native_config only includes providers whose own credential env is present', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { ANTHROPIC_API_KEY: 'a-key' },
      gatewayEnabled: false,
      nativeConfigReady: true,
      explicit: 'native_config',
    });
    expect(result.state).toBe('ready');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  test('healthy_but_no_models: a custom openai_compatible endpoint with no configured model id', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: { CUSTOM_LLM_PROTOCOL: 'openai', CUSTOM_LLM_BASE_URL: 'https://example.test/v1' },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('healthy_but_no_models');
  });

  test('ready: a custom openai_compatible endpoint with a configured model id', async () => {
    const result = await resolveHarnessModels({
      harness: 'opencode',
      projectId: 'proj-1',
      userId: 'user-1',
      env: {
        CUSTOM_LLM_PROTOCOL: 'openai',
        CUSTOM_LLM_BASE_URL: 'https://example.test/v1',
        CUSTOM_LLM_MODEL_ID: 'my-custom-model',
      },
      gatewayEnabled: false,
      nativeConfigReady: false,
    });
    expect(result.state).toBe('ready');
    expect(result.models).toEqual([
      { id: 'my-custom-model', name: 'my-custom-model', provider: 'custom' },
    ]);
  });
});

describe('regression: "startable with empty models" is unrepresentable', () => {
  // The exact bug class this module exists to kill: a catalog-driven harness
  // (ownsDefaultModel: false) resolving `ready` with an empty model list.
  // Swept across a matrix of realistic env/flag combinations — every branch
  // that reaches `ready` for a catalog-driven harness must carry a non-empty
  // `models` array; every branch with an empty conditioned catalog must NOT
  // be `ready`.
  const matrix: Array<{ env: Record<string, string>; gatewayEnabled: boolean }> = [
    { env: {}, gatewayEnabled: false },
    { env: {}, gatewayEnabled: true },
    { env: { ANTHROPIC_API_KEY: 'a-key' }, gatewayEnabled: false },
    { env: { ANTHROPIC_API_KEY: 'a-key' }, gatewayEnabled: true },
    { env: { OPENAI_API_KEY: 'o-key' }, gatewayEnabled: true },
  ];

  for (const [index, fixture] of matrix.entries()) {
    test(`opencode fixture #${index}: ready ⇒ non-empty models, empty models ⇒ never ready`, async () => {
      const result = await resolveHarnessModels({
        harness: 'opencode',
        projectId: 'proj-1',
        userId: 'user-1',
        env: fixture.env,
        gatewayEnabled: fixture.gatewayEnabled,
        nativeConfigReady: false,
      });
      if (result.state === 'ready') {
        expect(result.models.length).toBeGreaterThan(0);
      }
      if (result.models.length === 0) {
        expect(result.state).not.toBe('ready');
      }
    });
  }

  test('every ownsDefaultModel harness is ready-with-empty-models by construction, never healthy_but_no_models', async () => {
    for (const harness of HARNESS_IDS) {
      if (!HARNESSES[harness].ownsDefaultModel) continue;
      const kind = HARNESSES[harness].authKinds[0] as HarnessAuthKind;
      const env: Record<string, string> = {};
      if (kind === 'claude_subscription') env.CLAUDE_CODE_OAUTH_TOKEN = 'sub';
      if (kind === 'codex_subscription') env.CODEX_AUTH_JSON = '{}';
      const result: HarnessModelResolution = await resolveHarnessModels({
        harness,
        projectId: 'proj-1',
        userId: 'user-1',
        env,
        gatewayEnabled: false,
        nativeConfigReady: false,
        resolveCodex: async () => ({ access: 'token', accountId: undefined }),
      });
      expect(result.state).toBe('ready');
      expect(result.models).toEqual([]);
    }
  });
});

describe('CREDENTIAL_CUSTODY enforcement — assertRelayEligible / upstreamKindForCredential', () => {
  test('throws for every direct-only kind', () => {
    expect(() => assertRelayEligible('claude_subscription')).toThrow(
      CredentialCustodyViolationError,
    );
    expect(() => assertRelayEligible('native_config')).toThrow(CredentialCustodyViolationError);
  });

  test('never throws for a relay-eligible kind', () => {
    const relayEligible: HarnessAuthKind[] = [
      'managed_gateway',
      'anthropic_api_key',
      'codex_subscription',
      'openai_api_key',
      'openai_compatible',
      'anthropic_compatible',
    ];
    for (const kind of relayEligible) {
      expect(() => assertRelayEligible(kind)).not.toThrow();
    }
  });

  test('upstreamKindForCredential maps direct-only kinds to "direct" and everything else to "gateway"', () => {
    expect(upstreamKindForCredential('claude_subscription')).toBe('direct');
    expect(upstreamKindForCredential('native_config')).toBe('direct');
    expect(upstreamKindForCredential('managed_gateway')).toBe('gateway');
    expect(upstreamKindForCredential('anthropic_api_key')).toBe('gateway');
    expect(upstreamKindForCredential('codex_subscription')).toBe('gateway');
    expect(upstreamKindForCredential('openai_api_key')).toBe('gateway');
  });
});

describe('isCredentialConfigured — presence/flag checks per kind (moved from composer-capabilities.ts)', () => {
  test('managed_gateway is configured purely off the gateway flag', () => {
    expect(isCredentialConfigured('managed_gateway', {}, true, false)).toBe(true);
    expect(isCredentialConfigured('managed_gateway', {}, false, false)).toBe(false);
  });

  test('native_config is configured only when the caller says its config subtree is present', () => {
    expect(isCredentialConfigured('native_config', {}, false, true)).toBe(true);
    expect(isCredentialConfigured('native_config', {}, false, false)).toBe(false);
  });

  test('BYOK kinds require the relevant secret to be present and non-blank', () => {
    expect(
      isCredentialConfigured('anthropic_api_key', { ANTHROPIC_API_KEY: '  ' }, false, false),
    ).toBe(false);
    expect(
      isCredentialConfigured('anthropic_api_key', { ANTHROPIC_API_KEY: 'key' }, false, false),
    ).toBe(true);
  });
});
