import { describe, expect, test } from 'bun:test';

import {
  addPlatformMetaAgent,
  buildPlatformMetaOpenCodeConfig,
  builtinAgentConfigView,
  declaredBuiltinAgents,
  enabledBuiltinAgentKey,
  MY_KORTIX_DESCRIPTION,
  platformMetaAgentGrant,
  resolveBuiltinAgents,
  resolvePlatformMetaSandbox,
} from '../projects/lib/platform-meta-agent';
import { grantFromLoadedAgents } from '../projects/agents';
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
      default_agent: null,
      open_code_default_agent: null,
      agent_discovery: 'opencode',
    });

    expect(config.agents.filter((agent) => agent.name === 'meta')).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      name: 'meta',
      path: '/workspace/AGENTS.md',
      // Platform-owned: hosts render it read-only and never open the editor.
      platform: true,
      scope: {
        env: [],
        connectors: [],
        kortix_permissions: 'all',
      },
    });
    expect(config.open_code_default_agent).toBe('meta');
    expect(config.default_agent).toBe('meta');
  });

  test('defines the My Kortix agent that follows the platform guide', () => {
    expect(JSON.parse(buildPlatformMetaOpenCodeConfig())).toEqual({
      agent: {
        meta: {
          description: MY_KORTIX_DESCRIPTION,
          mode: 'primary',
          prompt:
            "You are My Kortix. Follow /workspace/AGENTS.md. Run the project through the Kortix CLI with the user's own permissions: answer and configure yourself, delegate every production task to a session of the narrowest project agent via --prompt, and report the verified result.\n\n" +
            'Prefer generative UI: when an answer is a plan, comparison, ranking, list of places or options, steps, a checklist, or 2 or more numbers, load the `kortix-genui` skill first and answer with `openui` blocks. Keep chat, short facts and code as prose.',
        },
      },
    });
    expect(MY_KORTIX_DESCRIPTION).toBe(
      'The one agent you talk to. It runs your agents, goals and spaces for you, with your permissions.',
    );
  });

  test('forces the meta sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolvePlatformMetaSandbox(undefined)).toBe('meta');
    expect(resolvePlatformMetaSandbox('meta')).toBe('meta');
    expect(() => resolvePlatformMetaSandbox('node22')).toThrow('META_SANDBOX_LOCKED');
  });

  test('grants the coordinator every project action without secrets or connectors', () => {
    expect(platformMetaAgentGrant()).toEqual({
      agent: 'meta',
      permissions: 'all',
      connectors: [],
      env: [],
    });
  });

  test('builtin_agents: the manifest boolean wins, else the legacy switch, else on', () => {
    expect(declaredBuiltinAgents({})).toEqual({});
    expect(declaredBuiltinAgents({ builtin_agents: { my_kortix: false } })).toEqual({ my_kortix: false });
    expect(declaredBuiltinAgents({ builtin_agents: { my_kortix: 'no' } })).toEqual({});
    expect(declaredBuiltinAgents({ builtin_agents: ['my_kortix'] })).toEqual({});
    // absent → legacy switch (default on)
    expect(resolveBuiltinAgents({}, true)).toEqual({ my_kortix: true });
    expect(resolveBuiltinAgents({}, false)).toEqual({ my_kortix: false });
    // present → the manifest decides, whatever the legacy switch says
    expect(resolveBuiltinAgents({ my_kortix: false }, true)).toEqual({ my_kortix: false });
    expect(resolveBuiltinAgents({ my_kortix: true }, false)).toEqual({ my_kortix: true });
  });

  test('`meta` is a built-in only while My Kortix is on', () => {
    expect(enabledBuiltinAgentKey('meta', { my_kortix: true })).toBe('my_kortix');
    expect(enabledBuiltinAgentKey('meta', { my_kortix: false })).toBeNull();
    expect(enabledBuiltinAgentKey('kortix', { my_kortix: true })).toBeNull();
    expect(builtinAgentConfigView('my_kortix', 3, 'kortix')).toMatchObject({
      agent: 'meta',
      builtin: 'my_kortix',
      editable: false,
      block: null,
      default_agent: 'kortix',
    });
  });

  test('a kortix.yaml that turns My Kortix off strips a meta session to no project action', () => {
    const governed = { specs: [], errors: [], defaultAgent: 'kortix', schemaVersion: 3 };
    expect(grantFromLoadedAgents('meta', governed)).toEqual(platformMetaAgentGrant());
    expect(grantFromLoadedAgents('meta', { ...governed, builtinAgents: { my_kortix: true } })).toEqual(
      platformMetaAgentGrant(),
    );
    expect(grantFromLoadedAgents('meta', { ...governed, builtinAgents: { my_kortix: false } })).toEqual({
      agent: 'meta',
      permissions: [],
      connectors: [],
      env: [],
    });
  });

  // Read through the canonical registry helper at every call site — the module
  // above must stay free of runtime imports, see its header comment.
  test('is gated on the meta_agent feature flag, default on', () => {
    // Default-on (Marko, 2026-10-24): the meta agent is the default cloud
    // orchestrator for every project. Only an explicit project opt-out hides it.
    expect(resolveFeatureFlag(null, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({}, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({ experimental: {} }, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { meta_agent: false } }, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { meta_agent: true } }, 'meta_agent')).toBe(true);
  });
});
