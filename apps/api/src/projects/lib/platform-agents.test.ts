/**
 * Unit tests for the platform-agent composition (R-34/R-35/R-37/R-44).
 *
 * The HTTP-level proof (real DB, real route, real experimental gate) lives in
 * ../../__tests__/integration-agi-agent-listing.test.ts. This file pins the
 * pure rule the route delegates to, including the shadowing case that is the
 * whole reason the composition happens outside `loadProjectAgents`.
 */
import { describe, expect, test } from 'bun:test';

import { AGI_AGENT_NAME } from '../agents';
import type { ProjectConfigSummary } from '../git/types';
import { AGI_AGENT_PATH, agiAgentListEntry, withPlatformAgents } from './platform-agents';

type Agent = ProjectConfigSummary['agents'][number];

const workspaceAgent = (name: string, extra: Partial<Agent> = {}): Agent => ({
  name,
  path: `.kortix/opencode/agents/${name}.md`,
  description: `the ${name} agent`,
  mode: 'primary',
  source: 'kortix.yaml',
  enabled: true,
  ...extra,
});

const config = (agents: Agent[]): ProjectConfigSummary => ({
  is_kortix_repo: true,
  signals: {},
  manifest_raw: null,
  manifest: {},
  env: { required: [], optional: [] },
  open_code_raw: null,
  open_code_default_agent: null,
  agent_discovery: 'declarative',
  agents,
  skills: [],
  commands: [],
});

const names = (summary: ProjectConfigSummary) => summary.agents.map((a) => a.name);

describe('agiAgentListEntry', () => {
  test('is marked platform-owned and carries a description worth showing', () => {
    const entry = agiAgentListEntry();

    expect(entry.name).toBe(AGI_AGENT_NAME);
    expect(entry.platform_owned).toBe(true);
    expect(entry.source).toBe('platform');
    expect(entry.enabled).toBe(true);
    // `subagent` would be filtered out of every picker (useVisibleAgents).
    expect(entry.mode).toBe('primary');
    expect(entry.path).toBe(AGI_AGENT_PATH);
    expect(entry.description).toBeTruthy();
    expect((entry.description ?? '').length).toBeGreaterThan(40);
  });

  test('describes what it is FOR, not how it is wired', () => {
    const description = (agiAgentListEntry().description ?? '').toLowerCase();
    expect(description).toContain('kortix agi');
    expect(description).toContain('session');
  });

  test('returns a fresh object — the list is mutated/sorted by callers', () => {
    expect(agiAgentListEntry()).not.toBe(agiAgentListEntry());
    expect(agiAgentListEntry()).toEqual(agiAgentListEntry());
  });
});

describe('withPlatformAgents — feature gate (R-44)', () => {
  test('agi ON: the AGI is present, and FIRST (R-37 elevation)', () => {
    const out = withPlatformAgents(config([workspaceAgent('kortix')]), { agiEnabled: true });

    expect(names(out)).toEqual([AGI_AGENT_NAME, 'kortix']);
    expect(out.agents[0].platform_owned).toBe(true);
  });

  test('agi OFF: the AGI is entirely absent', () => {
    const out = withPlatformAgents(config([workspaceAgent('kortix')]), { agiEnabled: false });

    expect(names(out)).toEqual(['kortix']);
    expect(out.agents.some((a) => a.platform_owned)).toBe(false);
  });

  test('agi ON with an empty roster: the AGI is still offerable (R-34)', () => {
    const out = withPlatformAgents(config([]), { agiEnabled: true });
    expect(names(out)).toEqual([AGI_AGENT_NAME]);
  });

  test('workspace agents are untouched — same objects, same order', () => {
    const kortix = workspaceAgent('kortix');
    const triage = workspaceAgent('triage', { source: 'opencode' });
    const out = withPlatformAgents(config([kortix, triage]), { agiEnabled: true });

    expect(out.agents[1]).toBe(kortix);
    expect(out.agents[2]).toBe(triage);
  });

  test('nothing else in the summary changes', () => {
    const base = config([workspaceAgent('kortix')]);
    const out = withPlatformAgents(base, { agiEnabled: true });

    expect({ ...out, agents: null }).toEqual({ ...base, agents: null });
  });
});

describe('withPlatformAgents — the reserved name is not shadowable (R-35)', () => {
  const impostor = workspaceAgent(AGI_AGENT_NAME, {
    description: 'totally normal helper',
    mode: 'subagent',
    enabled: true,
    scope: { env: [], connectors: [], kortix_cli: [] },
  });

  test('a manifest entry of the same name never reaches the list', () => {
    const out = withPlatformAgents(config([impostor, workspaceAgent('kortix')]), {
      agiEnabled: true,
    });

    expect(names(out)).toEqual([AGI_AGENT_NAME, 'kortix']);
    expect(out.agents[0]).toEqual(agiAgentListEntry());
    // The declared narrowing is gone — it could never have taken effect, since
    // the grant resolver answers this name before the roster is consulted.
    expect(out.agents[0].scope).toBeUndefined();
    expect(out.agents[0].description).not.toBe('totally normal helper');
  });

  test('a same-named entry cannot disable it', () => {
    const disabled = { ...impostor, enabled: false };
    const out = withPlatformAgents(config([disabled]), { agiEnabled: true });

    expect(names(out)).toEqual([AGI_AGENT_NAME]);
    expect(out.agents[0].enabled).toBe(true);
    expect(out.agents[0].platform_owned).toBe(true);
  });

  test('duplicated same-named entries still yield exactly one AGI', () => {
    const out = withPlatformAgents(config([impostor, { ...impostor }]), { agiEnabled: true });
    expect(names(out)).toEqual([AGI_AGENT_NAME]);
  });

  test('with agi OFF a same-named entry is dropped, not promoted', () => {
    const out = withPlatformAgents(config([impostor, workspaceAgent('kortix')]), {
      agiEnabled: false,
    });

    expect(names(out)).toEqual(['kortix']);
  });

  test('near-miss names are ordinary workspace agents', () => {
    const out = withPlatformAgents(
      config([workspaceAgent('agi'), workspaceAgent('kortix-agi-2')]),
      { agiEnabled: true },
    );

    expect(names(out)).toEqual([AGI_AGENT_NAME, 'agi', 'kortix-agi-2']);
    expect(out.agents[1].platform_owned).toBeUndefined();
    expect(out.agents[2].platform_owned).toBeUndefined();
  });
});
