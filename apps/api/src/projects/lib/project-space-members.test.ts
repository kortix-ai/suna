import { describe, expect, test } from 'bun:test';

import { canAddSpaceMembers, canRemoveSpaceMember, memberDisplayName } from './project-space-members';

const CREATOR = 'u-creator';
const MEMBER = 'u-member';
const OTHER = 'u-other';
const channel = { isDefault: false, createdBy: CREATOR };
const general = { isDefault: true, createdBy: null };

describe('who may add people to a channel', () => {
  test('a member of the channel, its creator or a project manager', () => {
    expect(canAddSpaceMembers(channel, { userId: MEMBER, manager: false }, true)).toBe(true);
    expect(canAddSpaceMembers(channel, { userId: CREATOR, manager: false }, false)).toBe(true);
    expect(canAddSpaceMembers(channel, { userId: OTHER, manager: true }, false)).toBe(true);
  });

  test('not a project member outside the channel: they join first', () => {
    expect(canAddSpaceMembers(channel, { userId: OTHER, manager: false }, false)).toBe(false);
  });

  test('nobody in #general: every project member is already in it', () => {
    expect(canAddSpaceMembers(general, { userId: OTHER, manager: true }, true)).toBe(false);
  });
});

describe('who may remove whom', () => {
  test('a manager removes anyone, the creator too', () => {
    const manager = { userId: OTHER, manager: true };
    expect(canRemoveSpaceMember(channel, manager, MEMBER)).toBe(true);
    expect(canRemoveSpaceMember(channel, manager, CREATOR)).toBe(true);
  });

  test('the creator removes anyone but themself', () => {
    const creator = { userId: CREATOR, manager: false };
    expect(canRemoveSpaceMember(channel, creator, MEMBER)).toBe(true);
    expect(canRemoveSpaceMember(channel, creator, CREATOR)).toBe(false);
  });

  test('a member removes only themself (Leave)', () => {
    const member = { userId: MEMBER, manager: false };
    expect(canRemoveSpaceMember(channel, member, MEMBER)).toBe(true);
    expect(canRemoveSpaceMember(channel, member, OTHER)).toBe(false);
    expect(canRemoveSpaceMember(channel, member, CREATOR)).toBe(false);
  });

  test('nobody leaves #general', () => {
    expect(canRemoveSpaceMember(general, { userId: MEMBER, manager: true }, MEMBER)).toBe(false);
  });
});

describe('the name a member row shows', () => {
  test('the display name; else the email local part; never the email', () => {
    expect(memberDisplayName({ displayName: 'Priya Rao', email: 'priya@example.test' })).toBe('Priya Rao');
    expect(memberDisplayName({ displayName: null, email: 'priya@example.test' })).toBe('priya');
    expect(memberDisplayName({ displayName: 'sam@example.test', email: 'sam@example.test' })).toBe('sam');
    expect(memberDisplayName({ displayName: '  ', email: null })).toBe('');
  });
});
