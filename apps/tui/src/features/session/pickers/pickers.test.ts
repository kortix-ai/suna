import { describe, expect, test } from 'bun:test';
import type { FlatModel } from '@kortix/sdk/react';

import type { ListItem } from '../../../ui/index.ts';
import { agentPickerItems } from './agent-picker.tsx';
import { AUTO_EFFORT_ID, effortPickerItems } from './effort-picker.tsx';
import { nextSelectable } from './inline-picker.tsx';
import { groupModels, isUnavailable, modelGroupId, modelGroupLabel } from './model-groups.ts';
import { modelPickerItems } from './model-picker.tsx';
import { effortChoices, effortLabel } from './use-composer-selection.ts';

function model(partial: Partial<FlatModel> & Pick<FlatModel, 'modelID' | 'modelName'>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    ...partial,
  } as FlatModel;
}

describe('modelGroupId', () => {
  test('prefers the explicit provider the gateway serves', () => {
    expect(modelGroupId(model({ modelID: 'x', modelName: 'X', provider: 'anthropic' }))).toBe(
      'anthropic',
    );
  });

  test('falls back to the namespaced wire id for a stale baked catalog', () => {
    expect(modelGroupId(model({ modelID: 'openai/gpt-5.6-sol', modelName: 'GPT' }))).toBe('openai');
  });

  test('a bare managed id with no provider stays under Kortix', () => {
    expect(modelGroupId(model({ modelID: 'glm-5.3-flash', modelName: 'GLM' }))).toBe('kortix');
  });

  test('a native provider groups under itself, never under Kortix', () => {
    expect(
      modelGroupId(model({ providerID: 'anthropic', modelID: 'claude', modelName: 'Claude' })),
    ).toBe('anthropic');
  });
});

describe('modelGroupLabel', () => {
  test('uses the canonical label, never the raw "Kortix" providerName', () => {
    expect(modelGroupLabel('anthropic')).toBe('Anthropic');
    expect(modelGroupLabel('openai')).toBe('OpenAI');
    expect(modelGroupLabel('xai')).toBe('xAI');
  });

  test('capitalizes an id it has never seen', () => {
    expect(modelGroupLabel('newprovider')).toBe('Newprovider');
    expect(modelGroupLabel('')).toBe('Other');
  });
});

describe('groupModels', () => {
  const models = [
    model({ modelID: 'openai/gpt-5.6-sol', modelName: 'GPT-5.6 Sol', provider: 'openai' }),
    model({ modelID: 'anthropic/opus-5', modelName: 'Opus 5', provider: 'anthropic' }),
    model({
      modelID: 'openai/o9',
      modelName: 'A9 Preview',
      provider: 'openai',
      enabled: false,
    }),
    model({ modelID: 'anthropic/sonnet-5', modelName: 'Claude Sonnet 5', provider: 'anthropic' }),
  ];

  test('groups by real provider and sorts the groups by label', () => {
    const groups = groupModels(models);
    expect(groups.map((group) => group.label)).toEqual(['Anthropic', 'OpenAI']);
  });

  test('offered models come before the ones the project turned off', () => {
    const openai = groupModels(models).find((group) => group.id === 'openai');
    expect(openai?.models.map((entry) => entry.modelName)).toEqual(['GPT-5.6 Sol', 'A9 Preview']);
  });

  test('models sort by name inside a group', () => {
    const anthropic = groupModels(models).find((group) => group.id === 'anthropic');
    expect(anthropic?.models.map((entry) => entry.modelName)).toEqual([
      'Claude Sonnet 5',
      'Opus 5',
    ]);
  });
});

describe('isUnavailable', () => {
  test('only an explicit false is unavailable — undefined is "not applicable"', () => {
    expect(isUnavailable(model({ modelID: 'a', modelName: 'A', enabled: false }))).toBe(true);
    expect(isUnavailable(model({ modelID: 'a', modelName: 'A', enabled: true }))).toBe(false);
    expect(isUnavailable(model({ modelID: 'a', modelName: 'A' }))).toBe(false);
  });
});

describe('modelPickerItems', () => {
  const groups = groupModels([
    model({ modelID: 'anthropic/sonnet-5', modelName: 'Claude Sonnet 5', provider: 'anthropic' }),
    model({ modelID: 'openai/o9', modelName: 'O9', provider: 'openai', enabled: false }),
  ]);

  test('emits one heading per group, marked as a header', () => {
    const { items, headerIds } = modelPickerItems(groups, null);
    expect(items.map((item) => item.id)).toEqual([
      'group:anthropic',
      'kortix:anthropic/sonnet-5',
      'group:openai',
      'kortix:openai/o9',
    ]);
    expect([...headerIds]).toEqual(['group:anthropic', 'group:openai']);
  });

  test('marks the selected model and tags an unavailable one', () => {
    const { items } = modelPickerItems(groups, {
      providerID: 'kortix',
      modelID: 'anthropic/sonnet-5',
    });
    expect(items[1]?.label).toBe('● Claude Sonnet 5');
    expect(items[3]?.right).toBe('off');
    expect(items[3]?.dim).toBe(true);
  });
});

describe('nextSelectable', () => {
  const items: ListItem[] = [
    { id: 'group:a', label: 'A' },
    { id: 'a1', label: 'a1' },
    { id: 'group:b', label: 'B' },
    { id: 'b1', label: 'b1' },
  ];
  const headers = new Set(['group:a', 'group:b']);

  test('skips a heading when moving down', () => {
    expect(nextSelectable(items, 0, 1, headers)).toBe(1);
    expect(nextSelectable(items, 2, 1, headers)).toBe(3);
  });

  test('skips a heading when moving up', () => {
    expect(nextSelectable(items, 2, -1, headers)).toBe(1);
  });

  test('past the end it lands on the first choice rather than a heading', () => {
    expect(nextSelectable(items, 9, 1, headers)).toBe(1);
    expect(nextSelectable(items, -1, -1, headers)).toBe(1);
  });

  test('a list of only headings has nothing to select', () => {
    expect(nextSelectable([{ id: 'group:a', label: 'A' }], 0, 1, headers)).toBe(-1);
  });
});

describe('effort', () => {
  test('choices are the model variant ids, de-duplicated', () => {
    expect(
      effortChoices(model({ modelID: 'a', modelName: 'A', variants: { low: {}, high: {} } })),
    ).toEqual(['low', 'high']);
  });

  test('a model with no variants offers none', () => {
    expect(effortChoices(model({ modelID: 'a', modelName: 'A' }))).toEqual([]);
    expect(effortChoices(undefined)).toEqual([]);
  });

  test('labels capitalize the catalog id, and null reads Auto', () => {
    expect(effortLabel('medium')).toBe('Medium');
    expect(effortLabel(null)).toBe('Auto');
  });

  test('Auto is always first so the control is not a one-way door', () => {
    const items = effortPickerItems(['low', 'high'], 'high');
    expect(items[0]?.id).toBe(AUTO_EFFORT_ID);
    expect(items.map((item) => item.label)).toEqual(['  Auto', '  Low', '● High']);
  });
});

describe('agentPickerItems', () => {
  test('marks the selected agent and tags the project default', () => {
    const items = agentPickerItems(
      [
        { name: 'galileo', description: 'Generalist', isDefault: true },
        { name: 'reviewer', description: 'Reviews diffs', isDefault: false },
      ],
      'reviewer',
    );
    expect(items[0]).toEqual({ id: 'agent:galileo', label: '  galileo', right: 'default' });
    expect(items[1]).toEqual({
      id: 'agent:reviewer',
      label: '● reviewer',
      right: 'Reviews diffs',
    });
  });
});
