import { describe, expect, test } from 'bun:test';
import {
  effectiveProviderPools,
  keysForSession,
  normalizePoolSelection,
  sessionPersonalUser,
  updateProviderPoolDraft,
} from './provider-pool-draft';

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

describe('keys a session can use (spec 2026-09-22 §2.3)', () => {
  const team = { secret_id: 'team', access_mode: 'project' as const, granted_user_ids: [] };
  const mine = { secret_id: 'mine', access_mode: 'members' as const, granted_user_ids: ['me'] };
  const theirs = { secret_id: 'theirs', access_mode: 'members' as const, granted_user_ids: ['someone-else'] };

  test('a private session reaches its creator`s own keys; a shared one reaches nobody`s', () => {
    expect(sessionPersonalUser({ visibility: 'private', created_by: 'me' })).toBe('me');
    expect(sessionPersonalUser({ visibility: 'project', created_by: 'me' })).toBeNull();
    expect(sessionPersonalUser({ visibility: 'restricted', created_by: 'me' })).toBeNull();
    expect(sessionPersonalUser(undefined)).toBeUndefined();
  });

  test('a shared session offers only keys shared with the whole project', () => {
    expect(keysForSession([team, mine, theirs], null).map((key) => key.secret_id)).toEqual(['team']);
  });

  test('a private session also offers keys granted to its creator, never another member`s', () => {
    expect(keysForSession([team, mine, theirs], 'me').map((key) => key.secret_id)).toEqual(['team', 'mine']);
  });

  test('an unknown session filters nothing: the server still refuses a key it cannot use', () => {
    expect(keysForSession([team, mine, theirs], undefined)).toHaveLength(3);
  });
});
