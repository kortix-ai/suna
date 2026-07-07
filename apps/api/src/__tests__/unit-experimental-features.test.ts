import { describe, expect, test } from 'bun:test';

import { config } from '../config';
import {
  applyExperimentalOverride,
  buildExperimentalCatalog,
  isExperimentalFeatureKey,
  resolveExperimentalFeature,
  resolveExperimentalFeatures,
} from '../experimental/features';
import { projectLlmGatewayEnabled } from '../llm-gateway/enablement';

function findCatalogFeature(key: string) {
  const feature = buildExperimentalCatalog({}).find((f) => f.key === key);
  if (!feature) throw new Error(`Missing experimental feature: ${key}`);
  return feature;
}

describe('isExperimentalFeatureKey', () => {
  test('accepts known keys, rejects others', () => {
    expect(isExperimentalFeatureKey('apps')).toBe(true);
    expect(isExperimentalFeatureKey('agent_tunnel')).toBe(true);
    expect(isExperimentalFeatureKey('agentmail_email')).toBe(true);
    expect(isExperimentalFeatureKey('llm_gateway')).toBe(true);
    expect(isExperimentalFeatureKey('inbox')).toBe(true);
    expect(isExperimentalFeatureKey('nope')).toBe(false);
    expect(isExperimentalFeatureKey(undefined)).toBe(false);
    expect(isExperimentalFeatureKey(42)).toBe(false);
  });
});

describe('resolveExperimentalFeature — explicit override wins', () => {
  test('per-project experimental map overrides the default', () => {
    expect(resolveExperimentalFeature({ experimental: { apps: true } }, 'apps')).toBe(true);
    expect(resolveExperimentalFeature({ experimental: { apps: false } }, 'apps')).toBe(false);
  });

  test('legacy top-level apps_enabled is honored for apps', () => {
    expect(resolveExperimentalFeature({ apps_enabled: true }, 'apps')).toBe(true);
    expect(resolveExperimentalFeature({ apps_enabled: false }, 'apps')).toBe(false);
  });

  test('experimental map takes precedence over the legacy field', () => {
    expect(
      resolveExperimentalFeature({ apps_enabled: false, experimental: { apps: true } }, 'apps'),
    ).toBe(true);
  });

  test('agent_tunnel respects explicit per-project choice', () => {
    const available = findCatalogFeature('agent_tunnel').available;
    expect(
      resolveExperimentalFeature({ experimental: { agent_tunnel: true } }, 'agent_tunnel'),
    ).toBe(available);
    expect(
      resolveExperimentalFeature({ experimental: { agent_tunnel: false } }, 'agent_tunnel'),
    ).toBe(false);
  });

  test('agentmail_email is explicit opt-in', () => {
    expect(resolveExperimentalFeature({}, 'agentmail_email')).toBe(false);
    expect(
      resolveExperimentalFeature({ experimental: { agentmail_email: true } }, 'agentmail_email'),
    ).toBe(true);
    expect(
      resolveExperimentalFeature({ experimental: { agentmail_email: false } }, 'agentmail_email'),
    ).toBe(false);
  });

  test('llm_gateway is platform-gated and defaults on when available', () => {
    const available = findCatalogFeature('llm_gateway').available;
    // No explicit project choice → inherits the platform: on wherever the
    // gateway is available and the fleet default is on (the global default).
    expect(resolveExperimentalFeature({}, 'llm_gateway')).toBe(
      available && config.LLM_GATEWAY_DEFAULT_ENABLED,
    );
    expect(resolveExperimentalFeature({ experimental: { llm_gateway: true } }, 'llm_gateway')).toBe(
      available,
    );
    expect(
      resolveExperimentalFeature({ experimental: { llm_gateway: false } }, 'llm_gateway'),
    ).toBe(false);
    expect(projectLlmGatewayEnabled({ experimental: { llm_gateway: true } })).toBe(available);
  });

  test('llm_gateway fleet default can roll all projects on while preserving kill switch and project off override', () => {
    const previousEnabled = config.LLM_GATEWAY_ENABLED;
    const previousDefault = config.LLM_GATEWAY_DEFAULT_ENABLED;
    try {
      config.LLM_GATEWAY_ENABLED = false;
      config.LLM_GATEWAY_DEFAULT_ENABLED = true;
      expect(resolveExperimentalFeature({}, 'llm_gateway')).toBe(false);
      expect(projectLlmGatewayEnabled({})).toBe(false);

      config.LLM_GATEWAY_ENABLED = true;
      config.LLM_GATEWAY_DEFAULT_ENABLED = false;
      expect(resolveExperimentalFeature({}, 'llm_gateway')).toBe(false);

      config.LLM_GATEWAY_DEFAULT_ENABLED = true;
      expect(resolveExperimentalFeature({}, 'llm_gateway')).toBe(true);
      expect(projectLlmGatewayEnabled({})).toBe(true);
      expect(
        resolveExperimentalFeature({ experimental: { llm_gateway: false } }, 'llm_gateway'),
      ).toBe(false);
      expect(projectLlmGatewayEnabled({ experimental: { llm_gateway: false } })).toBe(false);
    } finally {
      config.LLM_GATEWAY_ENABLED = previousEnabled;
      config.LLM_GATEWAY_DEFAULT_ENABLED = previousDefault;
    }
  });

  test('inbox is available and explicit opt-in (off by default)', () => {
    expect(findCatalogFeature('inbox').available).toBe(true);
    expect(resolveExperimentalFeature({}, 'inbox')).toBe(false);
    expect(resolveExperimentalFeature({ experimental: { inbox: true } }, 'inbox')).toBe(true);
    expect(resolveExperimentalFeature({ experimental: { inbox: false } }, 'inbox')).toBe(false);
  });

  test('null/empty metadata falls back to the operator default (no throw)', () => {
    expect(typeof resolveExperimentalFeature(null, 'apps')).toBe('boolean');
    expect(typeof resolveExperimentalFeature(undefined, 'agent_tunnel')).toBe('boolean');
    expect(typeof resolveExperimentalFeature({}, 'apps')).toBe('boolean');
  });
});

describe('resolveExperimentalFeatures', () => {
  test('returns an entry for every registered key', () => {
    const map = resolveExperimentalFeatures({ experimental: { apps: true } });
    for (const key of buildExperimentalCatalog({}).map((feature) => feature.key)) {
      expect(typeof map[key]).toBe('boolean');
    }
    expect(map.apps).toBe(true);
  });
});

describe('buildExperimentalCatalog', () => {
  test('describes each feature with effective + overridden flags', () => {
    const catalog = buildExperimentalCatalog({ experimental: { apps: true } });
    expect(catalog.length).toBeGreaterThan(0);

    const apps = catalog.find((f) => f.key === 'apps');
    if (!apps) throw new Error('Missing Apps feature');
    expect(apps.name).toBeTruthy();
    expect(apps.description).toBeTruthy();
    expect(apps.enabled).toBe(true);
    expect(apps.overridden).toBe(true);
    expect(typeof apps.available).toBe('boolean');

    const tunnel = catalog.find((f) => f.key === 'agent_tunnel');
    if (!tunnel) throw new Error('Missing Agent Computer Tunnel feature');
    expect(tunnel.overridden).toBe(false); // no explicit choice made
  });

  test('an unavailable feature is never enabled', () => {
    // We can only assert the invariant relative to availability.
    for (const f of buildExperimentalCatalog({
      experimental: { apps: true, agent_tunnel: true },
    })) {
      if (!f.available) expect(f.enabled).toBe(false);
    }
  });
});

describe('applyExperimentalOverride', () => {
  test('sets a boolean into metadata.experimental', () => {
    const next = applyExperimentalOverride({}, 'agent_tunnel', true);
    expect(next).toEqual({ experimental: { agent_tunnel: true } });
  });

  test('sets the llm_gateway override into metadata.experimental', () => {
    const next = applyExperimentalOverride({}, 'llm_gateway', true);
    expect(next).toEqual({ experimental: { llm_gateway: true } });
  });

  test('merges with existing overrides without clobbering', () => {
    const next = applyExperimentalOverride(
      { experimental: { apps: true }, name: 'keep-me' },
      'agent_tunnel',
      false,
    );
    expect(next.experimental).toEqual({ apps: true, agent_tunnel: false });
    expect(next.name).toBe('keep-me');
  });

  test('null clears the override; empty map is removed', () => {
    const next = applyExperimentalOverride({ experimental: { apps: true } }, 'apps', null);
    expect(next.experimental).toBeUndefined();
  });

  test('clears the legacy apps_enabled mirror when writing apps', () => {
    const next = applyExperimentalOverride({ apps_enabled: true }, 'apps', false);
    expect((next as Record<string, unknown>).apps_enabled).toBeUndefined();
    expect(next.experimental).toEqual({ apps: false });
  });

  test('writing apps:null also drops legacy apps_enabled', () => {
    const next = applyExperimentalOverride({ apps_enabled: true }, 'apps', null);
    expect((next as Record<string, unknown>).apps_enabled).toBeUndefined();
    expect(next.experimental).toBeUndefined();
  });
});
