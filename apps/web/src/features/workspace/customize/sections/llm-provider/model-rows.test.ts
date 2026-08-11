import { describe, expect, test } from 'bun:test';

import type { FlatModel } from '@/features/session/session-chat-input';
import { buildModelGroups } from './model-rows';

function model(modelID: string, over: Partial<FlatModel> = {}): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'dosco',
    modelID,
    modelName: modelID,
    ...over,
  } as FlatModel;
}

describe('buildModelGroups', () => {
  test('groups by the real upstream provider, not the synthetic kortix id', () => {
    const groups = buildModelGroups([
      model('anthropic/claude-sonnet-5', { provider: 'anthropic' }),
      model('openai/gpt-5.5', { provider: 'openai' }),
    ]);
    expect(groups.map((g) => g.providerName)).toEqual(['Anthropic', 'OpenAI']);
  });

  test('orders each group newest release first', () => {
    const [group] = buildModelGroups([
      model('anthropic/old', { provider: 'anthropic', releaseDate: '2025-01-01' }),
      model('anthropic/new', { provider: 'anthropic', releaseDate: '2026-06-01' }),
      model('anthropic/mid', { provider: 'anthropic', releaseDate: '2026-01-01' }),
    ]);
    expect(group.rows.map((r) => r.model.modelID)).toEqual([
      'anthropic/new',
      'anthropic/mid',
      'anthropic/old',
    ]);
  });

  test('flags the undated pointer when pinned snapshots exist', () => {
    // Both render as "Claude Sonnet 4.5"; without the flag they are two
    // indistinguishable rows with two independent switches.
    const [group] = buildModelGroups([
      model('anthropic/claude-sonnet-4-5', { provider: 'anthropic' }),
      model('anthropic/claude-sonnet-4-5-20250929', { provider: 'anthropic' }),
    ]);
    const byId = new Map(group.rows.map((r) => [r.model.modelID, r]));
    expect(byId.get('anthropic/claude-sonnet-4-5')?.isRollingAlias).toBe(true);
    expect(byId.get('anthropic/claude-sonnet-4-5-20250929')?.isRollingAlias).toBe(false);
  });

  test('does not flag an undated model with no pinned sibling', () => {
    const [group] = buildModelGroups([model('anthropic/claude-opus-5', { provider: 'anthropic' })]);
    expect(group.rows[0].isRollingAlias).toBe(false);
  });

  test('carries the wire id the server stores enablement against', () => {
    const [group] = buildModelGroups([
      model('anthropic/claude-sonnet-5', { provider: 'anthropic' }),
    ]);
    expect(group.rows[0].wireId).toBe('anthropic/claude-sonnet-5');
  });

  test('filters by name and by id, keeping groups that still have rows', () => {
    const models = [
      model('anthropic/claude-sonnet-5', { provider: 'anthropic', modelName: 'Claude Sonnet 5' }),
      model('openai/gpt-5.5', { provider: 'openai', modelName: 'GPT-5.5' }),
    ];
    expect(buildModelGroups(models, 'sonnet').map((g) => g.providerID)).toEqual(['anthropic']);
    expect(buildModelGroups(models, 'openai/').map((g) => g.providerID)).toEqual(['openai']);
    expect(buildModelGroups(models, 'nothing-matches')).toEqual([]);
  });
});
