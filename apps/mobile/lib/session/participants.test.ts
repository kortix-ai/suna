import { describe, expect, test } from 'bun:test';
import type { SessionMessageAuthors, SessionParticipant, SessionParticipants } from '@kortix/sdk';

import {
  messageAvatarPerson,
  messageSessionAuthor,
  participantSheetRows,
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

describe('messageAvatarPerson', () => {
  const ME = { kind: 'member' as const, user_id: 'owner', name: 'Owner Name', email: 'owner@example.test', avatar_url: 'https://img.example.test/o.png' };
  const THEM = { kind: 'member' as const, user_id: 'member', name: 'member', email: 'member@example.test', avatar_url: null };
  const BOT = { kind: 'session' as const, session_id: 'ses', name: 'Lead' };
  const authors = (map: SessionMessageAuthors['authors']): SessionMessageAuthors => ({ authors: map, initial_author: null });

  test('a shared session draws every member author, the viewer included, with their photo', () => {
    const data = authors({ m1: ME, m2: THEM });
    expect(messageAvatarPerson(data, view(), 'owner', 'm1')).toEqual({ name: 'Owner Name', email: 'owner@example.test', avatar_url: 'https://img.example.test/o.png' });
    expect(messageAvatarPerson(data, view(), 'owner', 'm2')).toEqual({ name: 'member', email: 'member@example.test', avatar_url: null });
  });

  test('a one-person session draws nothing for the viewer, but still draws someone else', () => {
    const solo = view({ participants: [OWNER], total: 1, multi_user: false });
    expect(messageAvatarPerson(authors({ m1: ME }), solo, 'owner', 'm1')).toBeNull();
    expect(messageAvatarPerson(authors({ m2: THEM }), solo, 'owner', 'm2')).not.toBeNull();
  });

  test('two distinct authors make a group chat even before participants load', () => {
    expect(messageAvatarPerson(authors({ m1: ME, m2: THEM }), undefined, 'owner', 'm1')).not.toBeNull();
  });

  test("another session's agent, an unknown message, or no data draws no avatar", () => {
    const data = authors({ m1: ME, m3: BOT });
    expect(messageAvatarPerson(data, view(), 'owner', 'm3')).toBeNull();
    expect(messageAvatarPerson(data, view(), 'owner', 'nope')).toBeNull();
    expect(messageAvatarPerson(undefined, view(), 'owner', 'm1')).toBeNull();
  });
});

describe('participantSheetRows', () => {
  test('one row per listed person: the name, else the email local part, and the email underneath', () => {
    const { rows, more } = participantSheetRows(view());
    expect(rows.map((row) => [row.key, row.name, row.email, row.isViewer])).toEqual([
      ['owner', 'Owner Name', 'owner@example.test', true],
      ['member', 'member', 'member@example.test', false],
    ]);
    expect(more).toBe(0);
  });

  test('people beyond the listed 20 are counted, never dropped silently', () => {
    expect(participantSheetRows(view({ total: 25 })).more).toBe(23);
  });

  test('no data, no rows', () => {
    expect(participantSheetRows(undefined)).toEqual({ rows: [], more: 0 });
  });
});

describe('messageSessionAuthor', () => {
  const coordinator = { kind: 'session', session_id: 'ses_parent', name: 'Release coordinator', agent: 'kortix' } as const;

  test('a message another session sent names that session', () => {
    const authors = { authors: { m1: coordinator }, initial_author: null } as SessionMessageAuthors;
    expect(messageSessionAuthor(authors, ['m1'], 'm1')).toEqual({
      session_id: 'ses_parent',
      name: 'Release coordinator',
      agent: 'kortix',
    });
  });

  test('a spawned session: initial_author goes to the first unauthored message only', () => {
    const authors = { authors: {}, initial_author: coordinator } as unknown as SessionMessageAuthors;
    expect(messageSessionAuthor(authors, ['m1', 'm2'], 'm1')?.session_id).toBe('ses_parent');
    expect(messageSessionAuthor(authors, ['m1', 'm2'], 'm2')).toBeNull();
  });

  test('a member author, or no author, is not a session sender', () => {
    const member = { kind: 'member', user_id: 'u1', name: 'Dana', email: 'dana@example.test' };
    const authors = { authors: { m1: member }, initial_author: null } as unknown as SessionMessageAuthors;
    expect(messageSessionAuthor(authors, ['m1'], 'm1')).toBeNull();
    expect(messageSessionAuthor(undefined, ['m1'], 'm1')).toBeNull();
  });
});
