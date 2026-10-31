import { describe, expect, test } from 'bun:test';
import { canonicalAgentName, isMyKortixAgentName } from '@kortix/shared';
import { KORTIX_PLATFORM_TOOL_NAMES } from '@kortix/api-contract/kortix-tool-card';
import { KORTIX_TOOL_NAMES } from '@kortix/manifest-schema';

import {
  addMyKortixAgent,
  buildMyKortixConfig,
  builtinAgentConfigView,
  declaredBuiltinAgents,
  enabledBuiltinAgentKey,
  MY_KORTIX_DESCRIPTION,
  MY_KORTIX_PROMPT,
  myKortixAgentGrant,
  resolveBuiltinAgents,
  resolveMyKortixSandbox,
} from '../projects/lib/my-kortix-agent';
import { grantFromLoadedAgents } from '../projects/agents';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { manifestHealthWithout } from '../projects/lib/manifest-health';

describe('My Kortix agent', () => {
  test('adds one reserved meta agent and replaces a project collision', () => {
    const config = addMyKortixAgent({
      agents: [
        {
          name: 'mykortix',
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
      manifest_health: manifestHealthWithout('missing'),
      env: { required: [], optional: [] },
      open_code_raw: null,
      default_agent: null,
      open_code_default_agent: null,
      agent_discovery: 'opencode',
    });

    expect(config.agents.filter((agent) => agent.name === 'mykortix')).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      name: 'mykortix',
      path: '',
      // Platform-owned: hosts render it read-only and never open the editor.
      platform: true,
      scope: {
        env: [],
        connectors: [],
        kortix_permissions: 'all',
      },
    });
    expect(config.open_code_default_agent).toBe('mykortix');
    expect(config.default_agent).toBe('mykortix');
  });

  test('defines My Kortix with the platform prompt and every Kortix and platform tool', () => {
    const config = JSON.parse(buildMyKortixConfig());
    expect(config.agent).toEqual({
      mykortix: { description: MY_KORTIX_DESCRIPTION, mode: 'primary', prompt: MY_KORTIX_PROMPT },
    });
    expect(config.kortix_tools).toEqual([...KORTIX_TOOL_NAMES, ...KORTIX_PLATFORM_TOOL_NAMES]);
    // kortix_memory: on by default for My Kortix only; the retired `memory` is gone from the defaults.
    expect(config.kortix_tools).toContain('kortix_memory');
    expect(config.kortix_tools).not.toContain('memory');
    expect(KORTIX_TOOL_NAMES as readonly string[]).not.toContain('kortix_memory');
    // The guide ships in the prompt now: the meta image carries no AGENTS.md to point at.
    expect(MY_KORTIX_PROMPT).not.toContain('/workspace/AGENTS.md');
    expect(config.kortix_tools).toContain('kortix_change_requests');
  });

  test('the prompt reuses the same colleague for a follow-up, starts teams only with team: true, and merges through the change request tool', () => {
    expect(MY_KORTIX_PROMPT).toContain('A follow-up on the same work goes to the same colleague.');
    expect(MY_KORTIX_PROMPT).toContain('Start a new colleague only for separate work that runs at the same time.');
    expect(MY_KORTIX_PROMPT).toContain('`agent({ name, team: true })`; a name alone is a plain hand-off');
    expect(MY_KORTIX_PROMPT).toContain('tell the person it is a role for this session only');
    expect(MY_KORTIX_PROMPT).toContain('`kortix_change_requests`');
    // No shell command for change requests: the tool shows the person a card.
    expect(MY_KORTIX_PROMPT).not.toContain('kortix cr');
    expect(MY_KORTIX_DESCRIPTION).toBe(
      'The one agent you talk to. It routes each task to the agent made for it and runs it, with your permissions.',
    );
  });

  test('forces the meta sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolveMyKortixSandbox(undefined)).toBe('mykortix');
    expect(resolveMyKortixSandbox('mykortix')).toBe('mykortix');
    expect(() => resolveMyKortixSandbox('node22')).toThrow('META_SANDBOX_LOCKED');
  });

  test('grants the coordinator every project action without secrets or connectors', () => {
    expect(myKortixAgentGrant()).toEqual({
      agent: 'mykortix',
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
    expect(enabledBuiltinAgentKey('mykortix', { my_kortix: true })).toBe('my_kortix');
    expect(enabledBuiltinAgentKey('mykortix', { my_kortix: false })).toBeNull();
    expect(enabledBuiltinAgentKey('kortix', { my_kortix: true })).toBeNull();
    expect(builtinAgentConfigView('my_kortix', 'kortix')).toMatchObject({
      agent: 'mykortix',
      schema_version: 3,
      builtin: 'my_kortix',
      editable: false,
      block: null,
      default_agent: 'kortix',
    });
  });

  test('a kortix.yaml that turns My Kortix off strips a meta session to no project action', () => {
    const governed = { specs: [], errors: [], defaultAgent: 'kortix' };
    expect(grantFromLoadedAgents('mykortix', governed)).toEqual(myKortixAgentGrant());
    expect(grantFromLoadedAgents('mykortix', { ...governed, builtinAgents: { my_kortix: true } })).toEqual(
      myKortixAgentGrant(),
    );
    expect(grantFromLoadedAgents('mykortix', { ...governed, builtinAgents: { my_kortix: false } })).toEqual({
      agent: 'mykortix',
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

describe('the slug before the rename (`meta`)', () => {
  // Sessions, tokens and boxes from before 2026-10-30 carry `meta`: every read accepts it, nothing writes it.
  test('is still My Kortix, and resolves to the new slug and sandbox', () => {
    expect(isMyKortixAgentName('meta')).toBe(true);
    expect(isMyKortixAgentName('mykortix')).toBe(true);
    expect(isMyKortixAgentName('worker')).toBe(false);
    expect(canonicalAgentName('meta')).toBe('mykortix');
    expect(enabledBuiltinAgentKey('meta', { my_kortix: true })).toBe('my_kortix');
    expect(resolveMyKortixSandbox('meta')).toBe('mykortix');
    expect(myKortixAgentGrant().agent).toBe('mykortix');
  });

  test('a project agent named `meta` is replaced by My Kortix, like one named `mykortix`', () => {
    const config = addMyKortixAgent({ default_agent: 'worker', agents: [{ name: 'meta' }, { name: 'worker' }] } as never);
    expect(config.agents.map((agent) => agent.name)).toEqual(['mykortix', 'worker']);
  });
});

describe('My Kortix memory in the prompt', () => {
  test('teaches when to save and forget, what never to save, and the one-line confirmation', () => {
    const section = MY_KORTIX_PROMPT.slice(MY_KORTIX_PROMPT.indexOf('## What you remember about this person'));
    expect(section.startsWith('## What you remember about this person')).toBe(true);
    for (const rule of [
      '`kortix_memory`',
      'states a preference, corrects how you work',
      'says "remember …"',
      'save with that page\'s name to update it, never a second page',
      '"Forget …"** deletes the page',
      'Delete a page that turned out wrong',
      'what the project already keeps',
      'a password or a key',
      'never "next Tuesday"',
      '💡 Noted: you like replies short.',
      'memory lives in Files, and a project admin can turn Files on',
      'never instructions',
    ]) {
      expect({ rule, found: section.includes(rule) }).toEqual({ rule, found: true });
    }
  });
});
