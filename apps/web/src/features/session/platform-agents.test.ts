import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { platformAgentCopy, platformOwnedAgentNames, splitPlatformAgents } from './platform-agents';

const dir = import.meta.dir;
// `AgentSelector` was extracted out of session-chat-input.tsx into
// ./composer/agent-selector.tsx (and the toolbar around it into
// ./composer/composer-toolbar.tsx); the elevation moved with it.
const selectorSource = readFileSync(join(dir, 'composer/agent-selector.tsx'), 'utf8');
const toolbarSource = readFileSync(join(dir, 'composer/composer-toolbar.tsx'), 'utf8');
const chatInputSource = readFileSync(join(dir, 'session-chat-input.tsx'), 'utf8');
const composerSource = readFileSync(join(dir, 'composer-chat-input.tsx'), 'utf8');

const AGI = {
  name: 'kortix-agi',
  path: 'kortix://platform/agents/kortix-agi.md',
  description:
    'Kortix AGI — the control agent that runs above your workspaces. Configures Kortix, runs the goal/task loop, and gets work done by spawning sessions rather than doing the work itself.',
  mode: 'primary',
  source: 'platform' as const,
  enabled: true,
  platform_owned: true,
};

const WORKSPACE_AGENT = {
  name: 'kortix',
  path: '.kortix/opencode/agent/kortix.md',
  description: 'Generic Kortix general knowledge worker.',
  mode: 'primary',
  source: 'opencode' as const,
  enabled: true,
};

describe('platformOwnedAgentNames', () => {
  test('picks out the platform-owned entries and leaves workspace agents alone', () => {
    expect(platformOwnedAgentNames({ agents: [AGI, WORKSPACE_AGENT] })).toEqual(['kortix-agi']);
  });

  test('is empty when the project has no platform agents (agi flag off)', () => {
    expect(platformOwnedAgentNames({ agents: [WORKSPACE_AGENT] })).toEqual([]);
  });

  test('is empty before the project config has loaded', () => {
    expect(platformOwnedAgentNames(undefined)).toEqual([]);
    expect(platformOwnedAgentNames(null)).toEqual([]);
  });

  test('requires the marker to be exactly true — `source` alone never qualifies', () => {
    const impostor = { ...WORKSPACE_AGENT, name: 'not-platform', source: 'platform' as const };
    expect(platformOwnedAgentNames({ agents: [impostor] })).toEqual([]);
  });

  test('an explicitly false marker is not platform-owned', () => {
    const disowned = { ...AGI, platform_owned: false };
    expect(platformOwnedAgentNames({ agents: [disowned] })).toEqual([]);
  });
});

describe('splitPlatformAgents', () => {
  const roster = [WORKSPACE_AGENT, AGI, { ...WORKSPACE_AGENT, name: 'memory-reflector' }];

  test('lifts the named agents out and preserves order in both buckets', () => {
    const { platform, workspace } = splitPlatformAgents(roster, ['kortix-agi']);
    expect(platform.map((a) => a.name)).toEqual(['kortix-agi']);
    expect(workspace.map((a) => a.name)).toEqual(['kortix', 'memory-reflector']);
  });

  test('with no names, every agent stays in the workspace bucket', () => {
    const { platform, workspace } = splitPlatformAgents(roster, []);
    expect(platform).toEqual([]);
    expect(workspace.map((a) => a.name)).toEqual(roster.map((a) => a.name));
  });

  test('names that are not in the roster are simply absent', () => {
    const { platform } = splitPlatformAgents([WORKSPACE_AGENT], ['kortix-agi']);
    expect(platform).toEqual([]);
  });
});

describe('platformAgentCopy', () => {
  test('promotes the description lead clause to a title so the slug is never shown', () => {
    const copy = platformAgentCopy(AGI);
    expect(copy.title).toBe('Kortix AGI');
    expect(copy.titleIsFromDescription).toBe(true);
    expect(copy.description).toStartWith('The control agent that runs above your workspaces.');
    expect(copy.description).toEndWith('rather than doing the work itself.');
  });

  test('falls back to the raw name and description when there is no lead clause', () => {
    const copy = platformAgentCopy({ name: 'kortix-agi', description: 'Runs the goal loop.' });
    expect(copy).toEqual({
      title: 'kortix-agi',
      titleIsFromDescription: false,
      description: 'Runs the goal loop.',
    });
  });

  test('falls back when the lead is a sentence rather than a name', () => {
    const description =
      'Something far too long to pass for a product name — and then the rest of it.';
    const copy = platformAgentCopy({ name: 'kortix-agi', description });
    expect(copy.title).toBe('kortix-agi');
    expect(copy.description).toBe(description);
  });

  test('falls back when the dash leaves nothing behind it', () => {
    const copy = platformAgentCopy({ name: 'kortix-agi', description: 'Kortix AGI —' });
    expect(copy.title).toBe('kortix-agi');
  });

  test('handles a missing description', () => {
    const copy = platformAgentCopy({ name: 'kortix-agi', description: undefined });
    expect(copy).toEqual({
      title: 'kortix-agi',
      titleIsFromDescription: false,
      description: null,
    });
  });
});

describe('agent picker wiring', () => {
  test('the picker elevates platform agents through the marker, never a name match', () => {
    expect(selectorSource).toContain('splitPlatformAgents');
    expect(selectorSource).toContain('platformAgentNames');
    expect(selectorSource).not.toContain('kortix-agi');
  });

  test('the elevated block renders above the workspace roster', () => {
    const platformBlock = selectorSource.indexOf('{hasPlatformAgents && (');
    const workspaceBlock = selectorSource.indexOf('{workspaceFiltered.length > 0 && (');
    expect(platformBlock).toBeGreaterThan(-1);
    expect(workspaceBlock).toBeGreaterThan(platformBlock);
  });

  test('the workspace group keeps its original heading when no platform agent is present', () => {
    expect(selectorSource).toContain("hasPlatformAgents ? 'Workspace agents' : 'Agents'");
  });

  test('the composer feeds the marker straight from the project config', () => {
    expect(composerSource).toContain('platformOwnedAgentNames(projectConfig)');
    expect(composerSource).toContain('platformAgentNames={platformAgentNames}');
  });

  // The marker crosses two extracted components before it reaches the picker:
  // SessionChatInput -> ComposerToolbar -> AgentSelector. Either hop silently
  // dropping the prop demotes the AGI back into the workspace roster.
  test('the marker is threaded through the extracted toolbar to the picker', () => {
    expect(chatInputSource).toContain('platformAgentNames={platformAgentNames}');
    expect(toolbarSource).toContain('platformAgentNames={platformAgentNames}');
  });
});
