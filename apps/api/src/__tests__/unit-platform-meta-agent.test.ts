import { describe, expect, test } from 'bun:test';

import {
  declaredBuiltinAgents,
  enabledBuiltinAgentKey,
  MY_KORTIX_BLOCK,
  MY_KORTIX_DESCRIPTION,
  MY_KORTIX_PROMPT,
  resolveBuiltinAgents,
  resolvePlatformMetaSandbox,
} from '../projects/lib/platform-meta-agent';
import { builtinAgentConfigView, withMyKortixAgent } from '../projects/lib/builtin-agents';
import { compileMyKortixAgentConfig, compileSelectedAgentConfig } from '../projects/lib/compile-agent-config';
import { grantFromLoadedAgents, myKortixGrant, sandboxFromLoadedAgents } from '../projects/agents';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';

describe('platform meta agent', () => {
  test('adds one My Kortix row, built by the manifest summarizer, and replaces a project collision', () => {
    const config = withMyKortixAgent({
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
    expect(config.agents[0]).toEqual({
      name: 'meta',
      path: 'builtin#agents.meta',
      description: MY_KORTIX_DESCRIPTION,
      mode: 'primary',
      model: null,
      space: null,
      source: 'kortix.yaml',
      enabled: true,
      sandbox: 'meta',
      scope: { env: [], connectors: [], kortix_permissions: 'all', kortix_cli: 'all', apps: [] },
      // Platform-owned: hosts render it read-only.
      platform: true,
      builtin: 'my_kortix',
    });
    expect(config.open_code_default_agent).toBe('meta');
    expect(config.default_agent).toBe('meta');
  });

  test('the block is a v3 agent: codemode only, every tool/skill/subagent/command, no connector/secret/App', () => {
    expect(MY_KORTIX_BLOCK).toEqual({
      description: MY_KORTIX_DESCRIPTION,
      mode: 'primary',
      prompt: MY_KORTIX_PROMPT,
      codemode: 'only',
      tools: 'all',
      skills: 'all',
      subagents: 'all',
      commands: 'all',
      connectors: 'none',
      secrets: 'none',
      apps: 'none',
      kortix_permissions: 'all',
      workspace: { project_repository: false },
      sandbox: 'meta',
    });
    expect(MY_KORTIX_DESCRIPTION).toBe(
      'The one agent you talk to. It routes each task to the agent made for it and runs it, with your permissions.',
    );
  });

  // A live onboarding session delegated with `kortix sessions new … --prompt`,
  // then `kortix sessions wait-for` inside bash (killed at 30 s), then
  // `kortix sessions cp`. The prompt now names the `agent` tool and forbids that.
  test('the prompt delegates with the `agent` tool, never the CLI spawn/wait/copy pattern', () => {
    expect(MY_KORTIX_PROMPT).toContain('Delegate every production task to the narrowest project agent with the `agent` tool.');
    expect(MY_KORTIX_PROMPT).toContain('waits until it finishes (up to 30 minutes) and returns its final message');
    expect(MY_KORTIX_PROMPT).toContain(
      'Never delegate or wait with `kortix sessions new`, `kortix sessions wait-for` or `kortix sessions cp`.',
    );
    expect(MY_KORTIX_PROMPT).toContain('Call `agent`, `question` and `show` directly.');
    expect(MY_KORTIX_PROMPT).toContain('`kortix-genui`');
    expect(MY_KORTIX_PROMPT).not.toContain('via --prompt');
  });

  test('compiles through the v3 compiler exactly like a declared `agents.meta` block', () => {
    const generic = compileSelectedAgentConfig({ kortix_version: 3, agents: { meta: MY_KORTIX_BLOCK } }, 'meta');
    expect(compileMyKortixAgentConfig(null)).toEqual(generic);
    // A v1/v2 manifest contributes no agents.
    expect(compileMyKortixAgentConfig({ kortix_version: 2, agents: { kortix: {} } })).toEqual(generic);
    expect(generic.schema).toBe(3);
    expect(generic.agent.meta).toMatchObject({
      description: MY_KORTIX_DESCRIPTION,
      mode: 'primary',
      prompt: MY_KORTIX_PROMPT,
      codemode: 'only',
    });
  });

  test("in a v3 project it may start the project's subagents and run its commands", () => {
    const manifest = {
      kortix_version: 3,
      default_agent: 'kortix',
      agents: {
        kortix: { mode: 'primary', prompt: 'Main.' },
        researcher: { mode: 'subagent', description: 'Researches.', prompt: 'Research.' },
      },
      commands: { recap: { prompt: 'Recap the day.' } },
    };
    const compiled = compileMyKortixAgentConfig(manifest);
    expect(compiled).toEqual(
      compileSelectedAgentConfig({ ...manifest, agents: { ...manifest.agents, meta: MY_KORTIX_BLOCK } }, 'meta'),
    );
    expect(Object.keys(compiled.agent).filter((name) => !compiled.agent[name]!.disable).sort()).toEqual(['meta', 'researcher']);
    expect(compiled.agent.meta!.permission).toMatchObject({ task: { '*': 'deny', researcher: 'allow' } });
    expect(compiled.commands?.recap?.agents).toEqual(['meta']);
  });

  test('forces the meta sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolvePlatformMetaSandbox(undefined)).toBe('meta');
    expect(resolvePlatformMetaSandbox('meta')).toBe('meta');
    expect(() => resolvePlatformMetaSandbox('node22')).toThrow('META_SANDBOX_LOCKED');
    expect(sandboxFromLoadedAgents('meta', { specs: [], errors: [] })).toBe('meta');
    expect(sandboxFromLoadedAgents('meta', { specs: [], errors: [], builtinAgents: { my_kortix: false } })).toBeNull();
  });

  test('the grant derives from the block: every project action, no secret, connector or App', () => {
    expect(myKortixGrant()).toEqual({
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
  });

  test('GET /agents/meta/config is the v3 view of the block, read-only', () => {
    const view = builtinAgentConfigView('my_kortix', 'kortix');
    expect(view).toMatchObject({
      agent: 'meta',
      builtin: 'my_kortix',
      schema_version: 3,
      editable: false,
      default_agent: 'kortix',
      harness: 'pi',
    });
    const { description, mode, prompt, workspace: _workspace, ...governance } = MY_KORTIX_BLOCK;
    const behavior = { description, mode, prompt };
    expect(view.block as Record<string, unknown>).toEqual({ ...governance, repository_access: false, behavior, opencode: behavior });
  });

  test('a kortix.yaml that turns My Kortix off strips a meta session to no project action', () => {
    const governed = { specs: [], errors: [], defaultAgent: 'kortix', schemaVersion: 3 };
    expect(grantFromLoadedAgents('meta', governed)).toEqual(myKortixGrant());
    expect(grantFromLoadedAgents('meta', { ...governed, builtinAgents: { my_kortix: true } })).toEqual(myKortixGrant());
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
