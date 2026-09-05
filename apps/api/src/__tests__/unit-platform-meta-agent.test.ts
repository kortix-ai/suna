import { describe, expect, test } from 'bun:test';

import {
  addPlatformMetaAgent,
  buildPlatformMetaOpenCodeConfig,
  platformMetaAgentGrant,
  resolvePlatformMetaSandbox,
} from '../projects/lib/platform-meta-agent';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';

describe('platform meta agent', () => {
  test('adds one reserved meta agent and replaces a project collision', () => {
    const config = addPlatformMetaAgent({
      agents: [
        {
          name: 'meta',
          path: '/project/AGENTS.md',
          source: 'opencode',
          description: 'project override',
          mode: 'primary',
        },
      ],
      commands: [],
      skills: [],
      subprojects: [],
      is_kortix_repo: true,
      signals: {},
      manifest_raw: null,
      manifest: {},
      manifest_version: resolveManifestVerdict({
        raw: null,
        format: 'yaml',
        path: null,
      }),
      env: { required: [], optional: [] },
      open_code_raw: null,
      open_code_default_agent: null,
      agent_discovery: 'opencode',
    });

    expect(config.agents.filter((agent) => agent.name === 'meta')).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      name: 'meta',
      path: '/workspace/AGENTS.md',
      scope: {
        env: [],
        connectors: [],
        kortix_cli: 'all',
      },
    });
    expect(config.open_code_default_agent).toBe('meta');
  });

  test('defines an OpenCode agent that follows the platform guide', () => {
    expect(JSON.parse(buildPlatformMetaOpenCodeConfig())).toEqual({
      agent: {
        meta: {
          description: 'Starts specialized Kortix sessions and coordinates their work.',
          mode: 'primary',
          prompt:
            'Follow /workspace/AGENTS.md. Coordinate work through the Kortix CLI. You are the only coordinator: spawn specialized sessions to do the work, give each one bounded task via --prompt, and never ask a session to spawn further sessions.',
        },
      },
    });
  });

  test('forces the meta sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolvePlatformMetaSandbox(undefined)).toBe('meta');
    expect(resolvePlatformMetaSandbox('meta')).toBe('meta');
    expect(() => resolvePlatformMetaSandbox('node22')).toThrow('META_SANDBOX_LOCKED');
  });

  test('grants the coordinator every project action without secrets or connectors', () => {
    expect(platformMetaAgentGrant()).toEqual({
      agent: 'meta',
      kortixCli: 'all',
      connectors: [],
      env: [],
    });
  });

  // Read through the canonical registry helper at every call site — the module
  // above must stay free of runtime imports, see its header comment.
  test('is gated on the meta_agent feature flag, default off', () => {
    expect(resolveFeatureFlag(null, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({}, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({ experimental: {} }, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { meta_agent: false } }, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { meta_agent: true } }, 'meta_agent')).toBe(true);
  });
});
