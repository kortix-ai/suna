import { describe, expect, test } from 'bun:test';

import { pickAutoStartModelSelection } from './onboarding-model-selection';
import type { ComposerCapabilities } from '@kortix/sdk/projects-client';
import type { ModelDefaultsResponse } from '@kortix/sdk/projects-client';

function caps(over: Partial<ComposerCapabilities> = {}): ComposerCapabilities {
  return {
    agent: {
      name: 'kortix',
      runtime: 'opencode',
      harness: 'opencode',
      native_agent: 'kortix',
      enabled: true,
    },
    auth: {
      compatible: ['managed_gateway'],
      active: 'managed_gateway',
      ready: true,
      reason: null,
    },
    model: {
      policy: 'gateway-catalog',
      default_allowed: true,
      custom_allowed: true,
      live_change: true,
      presets: [
        { id: 'glm-5.2', name: 'GLM 5.2', source: 'kortix-gateway' },
        { id: 'codex/gpt-5.6-sol', name: 'GPT-5.6 Sol', source: 'kortix-gateway' },
      ],
    },
    can_start: true,
    blocking_reason: null,
    ...over,
  };
}

function defaults(over: Partial<ModelDefaultsResponse> = {}): ModelDefaultsResponse {
  return {
    platformDefault: 'codex/gpt-5.6-sol',
    accountDefault: null,
    agentDefaults: {},
    projectDefault: null,
    resolvedForCaller: null,
    freeTier: false,
    ...over,
  };
}

describe('pickAutoStartModelSelection — nothing usable yet', () => {
  test('a blocked agent never auto-starts, and carries the reason for the caller', () => {
    expect(
      pickAutoStartModelSelection({
        capabilities: caps({ can_start: false, blocking_reason: 'Connect a model to continue.' }),
        defaults: defaults(),
        agentName: 'kortix',
      }),
    ).toEqual({ start: false, reason: 'Connect a model to continue.' });
  });

  test('a blocked agent with no stated reason still refuses to start', () => {
    expect(
      pickAutoStartModelSelection({
        capabilities: caps({ can_start: false, blocking_reason: null }),
        defaults: defaults(),
        agentName: 'kortix',
      }),
    ).toEqual({ start: false, reason: null });
  });
});

describe('pickAutoStartModelSelection — harnesses that own their default model', () => {
  // Claude/Codex `presets` are a curated OVERRIDE SUGGESTION list, not the
  // connection's model set. Sending one would silently override the user's
  // subscription default — and `requiresExplicitModelSelection` never fires
  // for these harnesses anyway, so the correct payload is no payload.
  for (const harness of ['claude', 'codex'] as const) {
    test(`${harness} starts with no model_selection at all`, () => {
      expect(
        pickAutoStartModelSelection({
          capabilities: caps({
            agent: {
              name: harness,
              runtime: harness,
              harness,
              native_agent: null,
              enabled: true,
            },
            model: { ...caps().model, policy: 'harness-catalog' },
          }),
          defaults: defaults({ accountDefault: 'glm-5.2' }),
          agentName: harness,
        }),
      ).toEqual({ start: true, selection: undefined });
    });
  }
});

describe('pickAutoStartModelSelection — catalog harnesses must send an explicit pick', () => {
  test('prefers the agent default when it names a real preset', () => {
    expect(
      pickAutoStartModelSelection({
        capabilities: caps(),
        defaults: defaults({
          agentDefaults: { kortix: 'glm-5.2' },
          accountDefault: 'codex/gpt-5.6-sol',
        }),
        agentName: 'kortix',
      }),
    ).toEqual({
      start: true,
      selection: { kind: 'preset', model_id: 'glm-5.2', connection_id: 'managed_gateway' },
    });
  });

  test('agent → project → account → platform, in that order', () => {
    const only = (over: Partial<ModelDefaultsResponse>) =>
      pickAutoStartModelSelection({
        capabilities: caps(),
        defaults: defaults(over),
        agentName: 'kortix',
      });

    expect(only({ projectDefault: 'glm-5.2' })).toMatchObject({
      selection: { model_id: 'glm-5.2' },
    });
    expect(only({ accountDefault: 'glm-5.2' })).toMatchObject({
      selection: { model_id: 'glm-5.2' },
    });
    // Nothing set anywhere → the platform default, which the fixture points at
    // the second preset.
    expect(only({})).toMatchObject({ selection: { model_id: 'codex/gpt-5.6-sol' } });
  });

  test('a default outside the preset list falls back to the first preset, never a 400', () => {
    // Model defaults are gateway WIRE models; presets come from the resolved
    // catalog. The namespaces need not coincide, and the API hard-rejects a
    // preset id it doesn't recognise (sessions.ts INVALID_MODEL_SELECTION).
    expect(
      pickAutoStartModelSelection({
        capabilities: caps(),
        defaults: defaults({ accountDefault: 'some/model-the-catalog-never-heard-of' }),
        agentName: 'kortix',
      }),
    ).toEqual({
      start: true,
      selection: { kind: 'preset', model_id: 'glm-5.2', connection_id: 'managed_gateway' },
    });
  });

  test('startable with an empty catalog falls back to kind:"default"', () => {
    expect(
      pickAutoStartModelSelection({
        capabilities: caps({ model: { ...caps().model, presets: [] } }),
        defaults: defaults(),
        agentName: 'kortix',
      }),
    ).toEqual({ start: true, selection: { kind: 'default' } });
  });

  test('carries the active connection so the pick and the connection cannot disagree', () => {
    const result = pickAutoStartModelSelection({
      capabilities: caps({
        auth: { compatible: ['openai_api_key'], active: 'openai_api_key', ready: true, reason: null },
      }),
      defaults: defaults(),
      agentName: 'kortix',
    });
    expect(result).toMatchObject({ selection: { connection_id: 'openai_api_key' } });
  });

  test('Pi is catalog-driven too — it gets an explicit pick, not a bare start', () => {
    const result = pickAutoStartModelSelection({
      capabilities: caps({
        agent: { name: 'pi', runtime: 'pi', harness: 'pi', native_agent: null, enabled: true },
      }),
      defaults: defaults(),
      agentName: 'pi',
    });
    expect(result).toMatchObject({ start: true, selection: { kind: 'preset' } });
  });
});
