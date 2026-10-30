import { describe, expect, test } from 'bun:test';
import { accessSummary, chatGptSharing, keyAccessFields, labelOwnerName, needsReconnection } from './account-secret-access';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

describe('keyAccessFields — who can use a new API key', () => {
  test('only you grants nobody else; the API adds the creator itself', () => {
    expect(keyAccessFields('private', [OTHER])).toEqual({ access_mode: 'members', user_ids: [] });
  });

  test('everyone in the project', () => {
    expect(keyAccessFields('project', [OTHER])).toEqual({ access_mode: 'project', user_ids: [] });
  });

  test('specific members names them', () => {
    expect(keyAccessFields('members', [OTHER, THIRD])).toEqual({ access_mode: 'members', user_ids: [OTHER, THIRD] });
  });
});

describe('chatGptSharing — who can use a new ChatGPT account', () => {
  test('only you is private to the connecting member', () => {
    expect(chatGptSharing('private', [OTHER], ME)).toEqual({ mode: 'private', ownerId: ME });
  });

  test('only you before the viewer is known stays owner-only', () => {
    expect(chatGptSharing('private', [], undefined)).toEqual({ mode: 'members', memberIds: [] });
  });

  test('everyone in the project', () => {
    expect(chatGptSharing('project', [OTHER], ME)).toEqual({ mode: 'project' });
  });

  test('specific members names them', () => {
    expect(chatGptSharing('members', [OTHER], ME)).toEqual({ mode: 'members', memberIds: [OTHER] });
  });

  test('specific members with nobody selected is only you', () => {
    expect(chatGptSharing('members', [], ME)).toEqual({ mode: 'private', ownerId: ME });
  });
});

describe('accessSummary — the access line on a connection row', () => {
  const row = (access_mode: 'project' | 'members', granted_user_ids: string[], created_by = ME) =>
    ({ access_mode, granted_user_ids, created_by });

  test('project access', () => {
    expect(accessSummary(row('project', []), ME)).toEqual({ kind: 'project' });
  });

  test('your own private connection', () => {
    expect(accessSummary(row('members', [ME]), ME)).toEqual({ kind: 'you' });
  });

  test("another member's private connection names its owner", () => {
    expect(accessSummary(row('members', [OTHER], OTHER), ME)).toEqual({ kind: 'owner', ownerId: OTHER });
  });

  test('shared with selected members counts every grantee', () => {
    expect(accessSummary(row('members', [ME, OTHER, THIRD]), ME)).toEqual({ kind: 'members', count: 3 });
  });

  test('a legacy restricted connection without its creator counts grantees', () => {
    expect(accessSummary(row('members', [], OTHER), ME)).toEqual({ kind: 'members', count: 0 });
  });
});

describe('labelOwnerName — the name in a new account default label', () => {
  test('first name from the full name', () => {
    expect(labelOwnerName({ email: 'ada@example.test', user_metadata: { full_name: '  Ada Lovelace ' } })).toBe('Ada');
  });

  test('falls back to the name, then the email local part', () => {
    expect(labelOwnerName({ email: 'ada@example.test', user_metadata: { name: 'Countess' } })).toBe('Countess');
    expect(labelOwnerName({ email: 'ada.l@example.test', user_metadata: {} })).toBe('ada.l');
  });

  test('no user yields no name', () => {
    expect(labelOwnerName(null)).toBe('');
  });
});

// The gateway marks an account whose login stopped working (needs_reauth_at);
// an inactive account needed reconnection before that mark existed.
describe('needsReconnection — a ChatGPT account the viewer must sign in to again', () => {
  test('a marked account needs reconnection', () => {
    expect(needsReconnection({ active: true, needs_reauth_at: '2026-09-25T10:00:00.000Z' })).toBe(true);
  });

  test('an inactive account needs reconnection', () => {
    expect(needsReconnection({ active: false, needs_reauth_at: null })).toBe(true);
  });

  test('a working account does not, including from an API without the field', () => {
    expect(needsReconnection({ active: true, needs_reauth_at: null })).toBe(false);
    expect(needsReconnection({ active: true })).toBe(false);
  });
});
