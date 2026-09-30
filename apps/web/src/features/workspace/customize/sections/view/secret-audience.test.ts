import { describe, expect, test } from 'bun:test';
import type { ConnectionShare } from '@kortix/sdk';

import { audienceDraftFrom, sameSharedWith, sharedWithFrom } from './secret-audience';

const share = (principal_type: ConnectionShare['principal_type'], principal_id: string): ConnectionShare => ({
  grant_id: `g-${principal_id}`,
  principal_type,
  principal_id,
  label: principal_id,
  expires_at: null,
});

describe('secret audience ↔ the Who can use it choice', () => {
  test('no grant, or a grant to the project, is Everyone', () => {
    expect(audienceDraftFrom([], 'me').audience).toBe('project');
    expect(audienceDraftFrom([share('project', 'p1')], 'me').audience).toBe('project');
  });

  test('a single grant to the viewer is Only you', () => {
    expect(audienceDraftFrom([share('member', 'me')], 'me').audience).toBe('private');
  });

  test('anything else is Specific people or groups, with the picks preselected', () => {
    expect(audienceDraftFrom([share('member', 'me'), share('group', 'g1')], 'me')).toEqual({
      audience: 'members',
      picked: { memberIds: ['me'], groupIds: ['g1'] },
    });
    // Another person's single grant is not "Only you" for this viewer.
    expect(audienceDraftFrom([share('member', 'them')], 'me').audience).toBe('members');
  });

  test('Save sends [] for Everyone, the viewer for Only you, the picks otherwise', () => {
    const picked = { memberIds: ['u1'], groupIds: ['g1'] };
    expect(sharedWithFrom({ audience: 'project', picked }, 'me')).toEqual([]);
    expect(sharedWithFrom({ audience: 'private', picked }, 'me')).toEqual([
      { principal_type: 'user', principal_id: 'me' },
    ]);
    expect(sharedWithFrom({ audience: 'members', picked }, 'me')).toEqual([
      { principal_type: 'user', principal_id: 'u1' },
      { principal_type: 'group', principal_id: 'g1' },
    ]);
  });

  test('Only you without a known viewer, or no pick, cannot be saved', () => {
    expect(sharedWithFrom({ audience: 'private', picked: { memberIds: [], groupIds: [] } }, null)).toBeNull();
    expect(sharedWithFrom({ audience: 'members', picked: { memberIds: [], groupIds: [] } }, 'me')).toBeNull();
  });

  test('an unchanged audience is detected regardless of order', () => {
    const stored = [share('group', 'g1'), share('member', 'u1')];
    expect(
      sameSharedWith(stored, [
        { principal_type: 'user', principal_id: 'u1' },
        { principal_type: 'group', principal_id: 'g1' },
      ]),
    ).toBe(true);
    expect(sameSharedWith(stored, [])).toBe(false);
    expect(sameSharedWith([], [])).toBe(true);
    expect(sameSharedWith([share('project', 'p1')], [])).toBe(true);
  });
});
