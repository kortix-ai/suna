import { describe, expect, test } from 'bun:test';
import {
  composerSelectableAgents,
  projectConfigAgentsToOpenCodeAgents,
  resolveComposerAgent,
  type ProjectConfigSummary,
} from '@kortix/sdk';

import {
  PICKER_SEARCH_THRESHOLD,
  agentDisplayName,
  composerChip,
  homeAgentPick,
  latestAssistantAgent,
  pickerSections,
  showsPickerSearch,
  nearestStop,
  stopOffset,
  variantDisplayName,
} from './composer-config';

const models = [
  { key: 'anthropic/sonnet', label: 'Sonnet 5', group: 'Anthropic', keywords: 'claude-sonnet-5' },
  { key: 'openai/gpt', label: 'GPT-5', group: 'OpenAI', keywords: 'gpt-5' },
  { key: 'anthropic/opus', label: 'Opus 5', group: 'Anthropic', keywords: 'claude-opus-5' },
];

describe('picker sheet sections', () => {
  test('groups by provider in first-seen order and keeps row order', () => {
    expect(pickerSections(models, '')).toEqual([
      { title: 'Anthropic', options: [models[0], models[2]] },
      { title: 'OpenAI', options: [models[1]] },
    ]);
  });

  test('options without a group form one untitled section', () => {
    const flat = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ];
    expect(pickerSections(flat, '')).toEqual([{ title: undefined, options: flat }]);
  });

  test('search matches label, group, and keywords; trims and ignores case', () => {
    expect(pickerSections(models, '  OPUS ')).toEqual([{ title: 'Anthropic', options: [models[2]] }]);
    expect(pickerSections(models, 'openai')).toEqual([{ title: 'OpenAI', options: [models[1]] }]);
    expect(pickerSections(models, 'claude-sonnet')).toEqual([{ title: 'Anthropic', options: [models[0]] }]);
    expect(pickerSections(models, 'gemini')).toEqual([]);
  });

  test('searchOnly rows: hidden from the empty-search view, found by a query (web modelInDefaultView)', () => {
    const rows = [models[0], { ...models[2], searchOnly: true }];
    expect(pickerSections(rows, '')).toEqual([{ title: 'Anthropic', options: [models[0]] }]);
    expect(pickerSections(rows, 'opus')).toEqual([{ title: 'Anthropic', options: [rows[1]] }]);
  });

  test('search shows only above the threshold', () => {
    expect(showsPickerSearch(PICKER_SEARCH_THRESHOLD)).toBe(false);
    expect(showsPickerSearch(PICKER_SEARCH_THRESHOLD + 1)).toBe(true);
  });
});

describe('composer chip (KRTX-247)', () => {
  test('the agent name, capitalised, not the model, as a low-key ghost chip', () => {
    expect(composerChip({ connectModel: false, agentName: 'kortix', modelName: 'Sonnet 5' })).toEqual({
      label: 'Kortix',
      variant: 'ghost',
    });
    expect(composerChip({ connectModel: false, agentName: 'plan', modelName: undefined })).toEqual({
      label: 'Plan',
      variant: 'ghost',
    });
  });

  test('no model connected reads "Connect model" as a louder secondary chip, whatever the agent', () => {
    const connect = { label: 'Connect model', variant: 'secondary' } as const;
    expect(composerChip({ connectModel: true, agentName: 'kortix', modelName: 'Sonnet 5' })).toEqual(connect);
    expect(composerChip({ connectModel: true, agentName: null, modelName: null })).toEqual(connect);
  });

  test('no agent resolves: the model name as a ghost chip, else no chip', () => {
    expect(composerChip({ connectModel: false, agentName: null, modelName: 'Sonnet 5' })).toEqual({
      label: 'Sonnet 5',
      variant: 'ghost',
    });
    expect(composerChip({ connectModel: false, agentName: undefined, modelName: undefined })).toBeNull();
    expect(composerChip({ connectModel: false, agentName: '', modelName: '' })).toBeNull();
  });

  test('agents still loading: the agent the send was made with, never the model name', () => {
    // A new thread: its sandbox has not listed its agents yet.
    expect(
      composerChip({ connectModel: false, agentName: null, pendingAgentName: 'kortix', agentsLoading: true, modelName: 'Sonnet 5' }),
    ).toEqual({ label: 'Kortix', variant: 'ghost' });
    expect(
      composerChip({ connectModel: false, agentName: null, pendingAgentName: null, agentsLoading: true, modelName: 'Sonnet 5' }),
    ).toBeNull();
    // Once they load, the resolved agent wins over the pending name.
    expect(
      composerChip({ connectModel: false, agentName: 'plan', pendingAgentName: 'kortix', agentsLoading: false, modelName: 'Sonnet 5' }),
    ).toEqual({ label: 'Plan', variant: 'ghost' });
  });
});

describe('thinking level names', () => {
  test('thinking level names', () => {
    expect(variantDisplayName(null)).toBe('Default');
    expect(variantDisplayName('xhigh')).toBe('Xhigh');
    expect(variantDisplayName('max')).toBe('Max');
  });
});

describe('agents — the SDK roster and resolver, fed mobile\'s inputs', () => {
  // `/projects/:id/detail` config of a local project (synthetic names), plus edge rows.
  const config = {
    default_agent: 'engineering',
    open_code_default_agent: 'engineering',
    agents: [
      { name: 'kortix', mode: 'primary', enabled: true, source: 'config' },
      { name: 'engineering', mode: 'primary', enabled: true, source: 'config' },
      { name: 'session-reviewer', mode: 'subagent', enabled: true, source: 'config' },
      { name: 'no-mode', mode: null, source: 'config' },
      { name: 'off', mode: 'primary', enabled: false, source: 'config' },
      { name: 'project-manager', mode: 'primary', enabled: true, source: 'config' },
    ],
  } as unknown as ProjectConfigSummary;
  const roster = projectConfigAgentsToOpenCodeAgents(config);

  test('the Agent tab: config agents only (no OpenCode build/plan), default first, no subagent, no disabled', () => {
    const names = composerSelectableAgents(roster, { enableProjects: false }).map((a) => a.name);
    expect(names).toEqual(['engineering', 'kortix', 'no-mode']);
    expect(names).not.toContain('build');
    expect(names).not.toContain('plan');
  });

  test('project-manager shows only with the projects feature on (web featureFlags.enableProjects)', () => {
    expect(composerSelectableAgents(roster, { enableProjects: true }).map((a) => a.name)).toContain('project-manager');
  });

  test('thread: the pick, else the latest assistant turn, else the bound agent, else the project default', () => {
    const messages = [
      { info: { role: 'user', agent: 'kortix' } },
      { info: { role: 'assistant', agent: 'kortix' } },
      { info: { role: 'user' } },
    ];
    const latest = latestAssistantAgent(messages);
    expect(latest).toBe('kortix');
    const thread = (picked: string | null, latestAgent: string | null, bound: string | null) =>
      resolveComposerAgent({ agents: roster, boundAgent: bound, defaultAgent: 'engineering', selectedAgent: picked ?? latestAgent }).selected;
    expect(thread('no-mode', latest, 'engineering')).toBe('no-mode');
    expect(thread(null, latest, 'engineering')).toBe('kortix');
    expect(thread(null, null, 'kortix')).toBe('kortix');
    expect(thread(null, null, null)).toBe('engineering');
    // A built-in the sandbox ran is not in the roster: the bound agent stands.
    expect(thread(null, 'build', 'kortix')).toBe('kortix');
    expect(latestAssistantAgent([])).toBeNull();
  });

  test('home: the pick, else the project default; the last-used agent counts only without a default', () => {
    const home = (picked: string | null, defaultAgent: string | null, lastUsed: string | null) =>
      resolveComposerAgent({
        agents: roster,
        defaultAgent,
        selectedAgent: homeAgentPick({ picked, defaultAgent, lastUsed }),
      }).selected;
    expect(home('kortix', 'engineering', null)).toBe('kortix');
    expect(home(null, 'engineering', 'kortix')).toBe('engineering');
    expect(home(null, null, 'kortix')).toBe('kortix');
    // A last-used agent of another project: the first (the default sorts first).
    expect(home(null, null, 'other')).toBe('engineering');
  });

  test('while the roster loads nothing is refused, and the pick or bound agent shows', () => {
    expect(resolveComposerAgent({ agents: undefined, boundAgent: 'kortix' })).toEqual({
      selected: 'kortix',
      disabled: false,
      reason: 'loading',
    });
  });

  test('display name capitalises the first letter; unknown agent says Agent', () => {
    expect(agentDisplayName('kortix')).toBe('Kortix');
    expect(agentDisplayName('chief-of-staff')).toBe('Chief-of-staff');
    expect(agentDisplayName(undefined)).toBe('Agent');
  });
});

describe('thinking slider stops', () => {
  // 4 stops over 300pt of thumb travel: 0, 100, 200, 300.
  test('stop offsets divide the travel evenly', () => {
    expect([0, 1, 2, 3].map((i) => stopOffset(i, 300, 4))).toEqual([0, 100, 200, 300]);
  });

  test('the nearest stop wins; positions outside the track clamp to the ends', () => {
    expect(nearestStop(49, 300, 4)).toBe(0);
    expect(nearestStop(51, 300, 4)).toBe(1);
    expect(nearestStop(-40, 300, 4)).toBe(0);
    expect(nearestStop(900, 300, 4)).toBe(3);
  });

  test('one stop, or a track not measured yet, stays at 0', () => {
    expect(stopOffset(0, 300, 1)).toBe(0);
    expect(nearestStop(120, 300, 1)).toBe(0);
    expect(nearestStop(120, 0, 4)).toBe(0);
  });
});
