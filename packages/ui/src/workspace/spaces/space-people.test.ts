import { describe, expect, test } from 'bun:test';
import type { ProjectSpaceMember } from '@kortix/sdk';

import { otherPersonOf, withMentionNames } from './space-people';

const member = (user_id: string, name: string): ProjectSpaceMember => ({
  user_id,
  name,
  avatar_url: null,
  is_creator: false,
  is_viewer: false,
  added_at: null,
  can_remove: false,
});

describe('mentions read as names', () => {
  const names = [
    { label: 'Ana Lima', tokens: ['ana@example.com', 'ana', 'ana-lima'] },
    { label: 'Worker', tokens: ['worker'] },
  ];

  test('email, local part, slug and agent tokens become display names; punctuation stays; unknown stays', () => {
    expect(withMentionNames('@ana@example.com and @worker, ping @ana-lima. Not @bob or me@ana', names)).toBe(
      '@Ana Lima and @Worker, ping @Ana Lima. Not @bob or me@ana',
    );
  });
});

describe('a two-person private space, from the viewer’s side', () => {
  const generated = (a: string, b: string) => `${a} and ${b}`;
  const space = { kind: 'channel' as const, visibility: 'private' as const, name: 'sam and Ana' };
  const members = [member('u-sam', 'sam'), member('u-ana', 'Ana Lima')];

  test('the generated name, in either order, reads as the other person', () => {
    expect(otherPersonOf(space, members, 'u-sam', generated)?.name).toBe('Ana Lima');
    expect(otherPersonOf(space, members, 'u-ana', generated)?.name).toBe('sam');
  });

  test('a space with its own name, a third member, or a public space keeps its name', () => {
    expect(otherPersonOf({ ...space, name: 'Hiring' }, members, 'u-sam', generated)).toBeNull();
    expect(otherPersonOf(space, [...members, member('u-bo', 'Bo')], 'u-sam', generated)).toBeNull();
    expect(otherPersonOf({ ...space, visibility: 'public' }, members, 'u-sam', generated)).toBeNull();
  });
});
