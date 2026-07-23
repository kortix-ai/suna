import { describe, expect, test } from 'bun:test';

import type { FlatModel } from '@/features/session/session-chat-input';
import { computeLatestSet, isDefaultVisible } from './use-model-store';

function monthsAgo(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString();
}

function model(partial: Partial<FlatModel> & Pick<FlatModel, 'providerID' | 'modelID'>): FlatModel {
  return {
    providerName: partial.providerID,
    modelName: partial.modelID,
    ...partial,
  };
}

describe('model-store visibility policy', () => {
  test('native defaults use models.dev latest metadata instead of showing every connected model', () => {
    const latest = computeLatestSet([
      model({
        providerID: 'anthropic',
        modelID: 'claude-old',
        family: 'claude',
        releaseDate: monthsAgo(2),
      }),
      model({
        providerID: 'anthropic',
        modelID: 'claude-new',
        family: 'claude',
        releaseDate: monthsAgo(1),
      }),
      model({
        providerID: 'anthropic',
        modelID: 'claude-legacy',
        family: 'claude-legacy',
        releaseDate: monthsAgo(8),
      }),
      model({
        providerID: 'openai',
        modelID: 'gpt-current',
        family: 'gpt',
        releaseDate: monthsAgo(1),
      }),
    ]);

    expect(latest.has('anthropic:claude-new')).toBe(true);
    expect(latest.has('openai:gpt-current')).toBe(true);
    expect(latest.has('anthropic:claude-old')).toBe(false);
    expect(latest.has('anthropic:claude-legacy')).toBe(false);
  });

  test('native Runtime Zen models are not special-cased as defaults', () => {
    expect(
      isDefaultVisible({ providerID: 'opencode', modelID: 'deepseek-v4-flash-free' }),
    ).toBe(false);
    expect(isDefaultVisible({ providerID: 'opencode', modelID: 'paid-model' })).toBe(false);
  });
});
