import { describe, expect, test } from 'bun:test';

import { filterTriggerAgents, flattenTriggerModelCatalog } from './trigger-picker-options';

describe('filterTriggerAgents', () => {
  test('drops subagents and keeps primary + unset-mode roles', () => {
    const result = filterTriggerAgents([
      { name: 'default', path: 'a', description: 'Default agent', mode: 'primary' },
      { name: 'helper', path: 'b', description: null, mode: 'subagent' },
      { name: 'legacy', path: 'c', description: null, mode: null },
    ]);
    expect(result).toEqual([
      { name: 'default', description: 'Default agent' },
      { name: 'legacy', description: null },
    ]);
  });

  test('returns an empty list when no agents are given', () => {
    expect(filterTriggerAgents(undefined)).toEqual([]);
    expect(filterTriggerAgents([])).toEqual([]);
  });
});

describe('flattenTriggerModelCatalog', () => {
  test('flattens and sorts by display name', () => {
    const result = flattenTriggerModelCatalog({
      'anthropic/claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' },
      'openai/gpt-5': { name: 'GPT-5' },
    });
    expect(result).toEqual([
      { modelID: 'anthropic/claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6' },
      { modelID: 'openai/gpt-5', modelName: 'GPT-5' },
    ]);
  });

  test('falls back to the model id when name is empty', () => {
    const result = flattenTriggerModelCatalog({ 'bare-model-id': { name: '' } });
    expect(result).toEqual([{ modelID: 'bare-model-id', modelName: 'bare-model-id' }]);
  });

  test('returns an empty list when the catalog is undefined', () => {
    expect(flattenTriggerModelCatalog(undefined)).toEqual([]);
  });
});
