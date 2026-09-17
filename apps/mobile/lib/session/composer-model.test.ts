import { describe, expect, test } from 'bun:test';

import {
  composerModelLabel,
  composerModelOptions,
  effectiveComposerModel,
  selectComposerModel,
} from './composer-model';

const catalog = {
  'claude-sonnet-4-6': { name: 'Sonnet 4.6' },
  'gpt-5': { name: 'GPT-5', enabled: true },
  'kimi-k2': { name: 'Kimi K2', enabled: false },
  'no-name': { name: '' },
};

describe('composer model pill', () => {
  test('lists offered models by name and hides disabled ones', () => {
    expect(composerModelOptions(catalog)).toEqual([
      { modelID: 'gpt-5', modelName: 'GPT-5' },
      { modelID: 'no-name', modelName: 'no-name' },
      { modelID: 'claude-sonnet-4-6', modelName: 'Sonnet 4.6' },
    ]);
    expect(composerModelOptions(undefined)).toEqual([]);
  });

  test('labels the pick, else the project default, and hides with no catalog', () => {
    const options = composerModelOptions(catalog);
    expect(composerModelLabel(options, 'gpt-5', 'claude-sonnet-4-6')).toBe('GPT-5');
    expect(composerModelLabel(options, null, 'claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(composerModelLabel(options, null, undefined)).toBe('Default');
    expect(composerModelLabel([], null, 'claude-sonnet-4-6')).toBeNull();
  });

  test('picking the default clears the pick; any other model pins it', () => {
    expect(selectComposerModel('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBeNull();
    expect(selectComposerModel('gpt-5', 'claude-sonnet-4-6')).toBe('gpt-5');
    expect(effectiveComposerModel(null, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(effectiveComposerModel('gpt-5', 'claude-sonnet-4-6')).toBe('gpt-5');
    expect(effectiveComposerModel(null, undefined)).toBeNull();
  });
});
