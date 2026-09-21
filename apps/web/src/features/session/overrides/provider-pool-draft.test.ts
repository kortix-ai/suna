import { describe, expect, test } from 'bun:test';
import { effectiveProviderPools, updateProviderPoolDraft } from './provider-pool-draft';

const saved = [{ provider_id: 'anthropic', secret_ids: ['primary'] }, { provider_id: 'openai', secret_ids: ['other'] }];

describe('provider key drafts', () => {
  test('changing one provider retains another provider draft', () => {
    expect(updateProviderPoolDraft({ openai: [] }, 'anthropic', ['backup'], saved)).toEqual({ openai: [], anthropic: ['backup'] });
  });

  test('restoring the saved selection removes only that provider draft', () => {
    expect(updateProviderPoolDraft({ openai: [], anthropic: ['backup'] }, 'anthropic', ['primary'], saved)).toEqual({ openai: [] });
  });

  test('empty selection is a disabled provider, not an inherited default', () => {
    expect(updateProviderPoolDraft({}, 'codex', [], saved)).toEqual({ codex: [] });
    expect(updateProviderPoolDraft({ codex: [] }, 'codex', null, saved)).toEqual({});
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
