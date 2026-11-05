import { describe, expect, test } from 'bun:test';
import type { ProjectSession, ProjectSpace } from '@kortix/sdk';

import {
  isPersonalSpace,
  isPrivateSpace,
  orderSpaces,
  spaceDisplayName,
  spaceInitials,
  spacePreview,
  viewerFirstName,
} from './space-identity';

function space(over: Partial<ProjectSpace>): ProjectSpace {
  return {
    space_id: over.space_id ?? 'sp-1',
    kind: 'channel',
    slug: 'launch',
    name: 'Launch',
    description: null,
    is_default: false,
    dm_agent_name: null,
    archived_at: null,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...over,
  };
}

function thread(over: Partial<ProjectSession>): ProjectSession {
  return { session_id: 's', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over } as ProjectSession;
}

const personal = space({ space_id: 'dm-1', kind: 'dm', slug: null, name: 'mykortix', dm_agent_name: 'mykortix' });
const workerDm = space({ space_id: 'dm-2', kind: 'dm', slug: null, name: 'worker', dm_agent_name: 'worker' });

describe('space identity', () => {
  test('the DM with My Kortix is the personal space; any other DM is a private space', () => {
    expect(isPersonalSpace(personal)).toBe(true);
    expect(isPersonalSpace(workerDm)).toBe(false);
    expect(isPrivateSpace(workerDm)).toBe(true);
    expect(isPrivateSpace(space({ visibility: 'private' }))).toBe(true);
    expect(isPrivateSpace(space({ visibility: 'public' }))).toBe(false);
  });

  test('names: the personal label, the agent of another DM, the channel name', () => {
    expect(spaceDisplayName(personal, "Ada's space")).toBe("Ada's space");
    expect(spaceDisplayName(workerDm, 'x')).toBe('Worker');
    expect(spaceDisplayName(space({}), 'x')).toBe('Launch');
  });

  test('first name from the profile, never from an email', () => {
    expect(viewerFirstName({ full_name: 'Ada Lovelace' })).toBe('Ada');
    expect(viewerFirstName({ name: 'ada@example.com' })).toBeNull();
    expect(viewerFirstName(undefined)).toBeNull();
  });

  test('initials: two words give two capitals, one word its first two letters', () => {
    expect(spaceInitials('Night shift')).toBe('NS');
    expect(spaceInitials('Marketing')).toBe('Ma');
    expect(spaceInitials('#')).toBe('#');
  });

  test('preview: the newest thread, its reply before its first message', () => {
    expect(spacePreview([])).toBeNull();
    const older = thread({ session_id: 'a', updated_at: '2026-11-01T00:00:00Z', first_prompt: 'old' });
    const newer = thread({ session_id: 'b', updated_at: '2026-11-02T00:00:00Z', first_prompt: 'Book a flight', result_excerpt: 'Booked:\n seat 14C' });
    expect(spacePreview([older, newer])).toBe('Booked: seat 14C');
    expect(spacePreview([thread({ first_prompt: 'Summarize the week' })])).toBe('Summarize the week');
    expect(spacePreview([thread({ result_excerpt: 'Done @ada@example.com, see you' })])).toBe('Done @ada, see you');
  });

  test('order: the personal space first; archived spaces and DMs with other agents left out', () => {
    const general = space({ space_id: 'g', is_default: true, slug: 'general', name: 'general' });
    const archived = space({ space_id: 'old', archived_at: '2026-11-01T00:00:00Z' });
    const { personal: first, others } = orderSpaces([general, archived, workerDm, personal]);
    expect(first?.space_id).toBe('dm-1');
    expect(others.map((s) => s.space_id)).toEqual(['g']);
  });
});
