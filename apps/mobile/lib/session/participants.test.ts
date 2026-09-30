import { describe, expect, test } from 'bun:test';
import type { SessionParticipant, SessionParticipants } from '@kortix/sdk';

import {
  participantAvatarText,
  participantInitials,
  participantName,
  participantStack,
} from './participants';

const person = (id: string, overrides: Partial<SessionParticipant> = {}): SessionParticipant => ({
  user_id: id,
  name: null,
  email: `${id}@example.test`,
  avatar_url: null,
  is_viewer: false,
  ...overrides,
});

const OWNER = person('owner', { name: 'Owner Name', is_viewer: true });
const MEMBER = person('member');

const view = (overrides: Partial<SessionParticipants> = {}): SessionParticipants => ({
  participants: [OWNER, MEMBER],
  total: 2,
  multi_user: true,
  senders: {},
  sender_profiles: [],
  ...overrides,
});

describe('participantName', () => {
  test('the display name, else the email local part, the viewer included', () => {
    expect(participantName(OWNER)).toBe('Owner Name');
    expect(participantName(person('a', { name: ' Ada Lovelace ' }))).toBe('Ada Lovelace');
    expect(participantName(MEMBER)).toBe('member');
    expect(participantName(person('b', { email: null }))).toBe('');
  });
});

describe('participantAvatarText', () => {
  test('the real name or email, never "You": the initial and colour identify the person', () => {
    expect(participantAvatarText(OWNER)).toBe('Owner Name');
    expect(participantAvatarText(MEMBER)).toBe('member@example.test');
    expect(participantAvatarText(person('b', { email: null }))).toBeUndefined();
  });
});

describe('participantStack', () => {
  test('null for a single-user session and before the first read', () => {
    expect(participantStack(undefined, 2)).toBeNull();
    expect(participantStack(view({ multi_user: false, total: 1, participants: [OWNER] }), 2)).toBeNull();
    // Multi-user only through a removed sender: one person can open it now.
    expect(participantStack(view({ total: 1, participants: [OWNER] }), 2)).toBeNull();
  });

  test('two people: both faces, no count', () => {
    expect(participantStack(view(), 2)).toEqual({
      shown: [OWNER, MEMBER],
      more: 0,
      label: 'People in this session: Owner Name, member',
    });
  });

  test('more people than faces: the rest is a count taken from the total', () => {
    const stack = participantStack(view({ participants: [OWNER, MEMBER, person('c')], total: 7 }), 2);
    expect(stack?.shown).toEqual([OWNER, MEMBER]);
    expect(stack?.more).toBe(5);
    expect(stack?.label).toBe('People in this session: Owner Name, member and 5 more');
  });
});

describe('participantInitials', () => {
  test('first and last word of the name, like web UserAvatar', () => {
    expect(participantInitials(person('a', { name: 'Maya Chen' }))).toBe('MC');
    expect(participantInitials(person('a', { name: ' ada  de la lovelace ' }))).toBe('AL');
    expect(participantInitials(person('a', { name: 'Maya' }))).toBe('M');
  });

  test('without a name, the email local part split on . _ -', () => {
    expect(participantInitials(person('a', { email: 'maya.chen@example.test' }))).toBe('MC');
    expect(participantInitials(person('a', { email: 'maya@example.test' }))).toBe('M');
  });

  test('nothing to read gives ?', () => {
    expect(participantInitials(person('a', { email: null }))).toBe('?');
  });
});
