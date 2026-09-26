import { describe, expect, test } from 'bun:test';

import {
  PICKER_SEARCH_THRESHOLD,
  agentDisplayName,
  composerChip,
  pickerSections,
  homeAgentName,
  pickableAgents,
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
});

describe('thinking level names', () => {
  test('thinking level names', () => {
    expect(variantDisplayName(null)).toBe('Default');
    expect(variantDisplayName('xhigh')).toBe('Xhigh');
    expect(variantDisplayName('max')).toBe('Max');
  });
});

describe('agents', () => {
  const agent = (name: string, mode: 'primary' | 'subagent' | 'all', hidden = false) => ({ name, mode, hidden });

  test('pickable = primary or all, not hidden, not disabled', () => {
    const list = [agent('kortix', 'primary'), agent('explore', 'subagent'), agent('plan', 'all'), agent('ghost', 'primary', true)];
    expect(pickableAgents(list).map((a) => a.name)).toEqual(['kortix', 'plan']);
  });

  test('project config agents: a missing mode is "all" (OpenCode default); `enabled: false` is out', () => {
    // `/projects/:id/detail` of a local project, 2026-09-21, plus the two edge rows.
    const config = [
      { name: 'harness-reflector', mode: 'primary', enabled: true },
      { name: 'kortix', mode: 'primary', enabled: true },
      { name: 'session-reviewer', mode: 'subagent', enabled: true },
      { name: 'no-mode', mode: null },
      { name: 'off', mode: 'primary', enabled: false },
    ];
    expect(pickableAgents(config).map((a) => a.name)).toEqual(['harness-reflector', 'kortix', 'no-mode']);
  });

  test('home agent: the pick, else the project default, else the last used; only a pickable one', () => {
    const names = ['harness-reflector', 'kortix'];
    expect(homeAgentName(names, { picked: 'kortix', projectDefault: 'harness-reflector', lastUsed: null })).toBe('kortix');
    expect(homeAgentName(names, { picked: null, projectDefault: 'harness-reflector', lastUsed: 'kortix' })).toBe('harness-reflector');
    expect(homeAgentName(names, { picked: null, projectDefault: null, lastUsed: 'kortix' })).toBe('kortix');
    // A last-used agent of another project, and no default: the server decides.
    expect(homeAgentName(names, { picked: null, projectDefault: null, lastUsed: 'plan' })).toBeNull();
    expect(homeAgentName(names, { picked: 'gone', projectDefault: 'also-gone', lastUsed: null })).toBeNull();
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
