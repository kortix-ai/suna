import { describe, expect, test } from 'bun:test';

import { PROJECT_ACTIONS } from '../iam/actions';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';
import {
  addPlatformMetaAgent,
  buildPlatformMetaOpenCodeConfig,
  platformMetaAgentGrant,
  platformMetaAgentEnabledForSession,
  projectMetaAgentEnabled,
  resolvePlatformMetaSandbox,
} from '../projects/lib/platform-meta-agent';

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
        kortix_cli: expect.any(Array),
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

  test('denies merge authority by construction while retaining other project actions', () => {
    const expectedActions = Object.values(PROJECT_ACTIONS).filter(
      (action) => action !== 'project.cr.merge' && action !== 'project.gitops.merge',
    );

    expect(platformMetaAgentGrant()).toEqual({
      agent: 'meta',
      kortixCli: expectedActions,
      connectors: [],
      env: [],
    });
    expect(platformMetaAgentGrant().kortixCli).not.toBe('all');
    expect(
      addPlatformMetaAgent({
        agents: [],
        commands: [],
        skills: [],
        is_kortix_repo: true,
        signals: {},
        manifest_raw: null,
        manifest: {},
        manifest_version: resolveManifestVerdict({ raw: null, format: 'yaml', path: null }),
        env: { required: [], optional: [] },
        open_code_raw: null,
        open_code_default_agent: null,
        agent_discovery: 'opencode',
      }).agents[0]?.scope?.kortix_cli,
    ).toEqual(expectedActions);
  });

  test('is gated on the meta_agent experimental flag, default off', () => {
    expect(projectMetaAgentEnabled(null)).toBe(false);
    expect(projectMetaAgentEnabled({})).toBe(false);
    expect(projectMetaAgentEnabled({ experimental: {} })).toBe(false);
    expect(projectMetaAgentEnabled({ experimental: { meta_agent: false } })).toBe(false);
    expect(projectMetaAgentEnabled({ experimental: { meta_agent: true } })).toBe(true);
  });

  test('enables meta only for a trusted generated goal push when the project flag is off', () => {
    expect(platformMetaAgentEnabledForSession(null, 'meta', true)).toBe(true);
    expect(
      platformMetaAgentEnabledForSession(
        { experimental: { meta_agent: false } },
        'meta',
        true,
      ),
    ).toBe(true);
  });

  test('keeps arbitrary and forged meta requests gated off by default', () => {
    expect(platformMetaAgentEnabledForSession(null, 'meta', false)).toBe(false);
    expect(platformMetaAgentEnabledForSession(null, 'worker', true)).toBe(false);
    expect(
      platformMetaAgentEnabledForSession(
        { experimental: { meta_agent: true } },
        'meta',
        false,
      ),
    ).toBe(true);
  });

});
