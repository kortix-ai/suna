import { describe, expect, test } from 'bun:test';
import { effectiveProviderPools, normalizePoolSelection, updateProviderPoolDraft } from './provider-pool-draft';

const saved = [{ provider_id: 'anthropic', secret_ids: ['primary'] }, { provider_id: 'openai', secret_ids: ['other'] }];

describe('provider key drafts', () => {
  test('changing one provider retains another provider draft', () => {
    expect(updateProviderPoolDraft({ openai: [] }, 'anthropic', ['backup'], saved)).toEqual({ openai: [], anthropic: ['backup'] });
  });

  test('restoring the saved selection removes only that provider draft', () => {
    expect(updateProviderPoolDraft({ openai: [], anthropic: ['backup'] }, 'anthropic', ['primary'], saved)).toEqual({ openai: [] });
  });

  test('unchecking the last key resets to the default instead of saving an empty pool', () => {
    // The gateway treats a configured empty pool as "no usable key": every turn
    // fails with provider_not_connected. An empty selection means "default".
    expect(updateProviderPoolDraft({}, 'codex', [], saved)).toEqual({});
    expect(updateProviderPoolDraft({}, 'anthropic', [], saved)).toEqual({ anthropic: null });
  });

  test('normalizePoolSelection maps an empty list to the default', () => {
    expect(normalizePoolSelection([])).toBeNull();
    expect(normalizePoolSelection(null)).toBeNull();
    expect(normalizePoolSelection(['a'])).toEqual(['a']);
  });

  test('reset remains staged until the common save action', () => {
    const drafts = updateProviderPoolDraft({}, 'anthropic', null, saved);
    expect(drafts).toEqual({ anthropic: null });
    expect(effectiveProviderPools(saved, drafts)).toEqual({ openai: ['other'] });
    expect(saved[0].secret_ids).toEqual(['primary']);
  });

  test('summary includes every draft and preserves explicit empty pools', () => {
    expect(effectiveProviderPools(saved, { anthropic: ['backup'], openai: [], codex: ['personal'] })).toEqual({ anthropic: ['backup'], openai: [], codex: ['personal'] });
  });
});
