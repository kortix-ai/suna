import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';

import {
  matchesAccessFilters,
  matchesOwnerFilters,
  resolveAccessFacetOptions,
  resolveOwnerFacetOptions,
  sessionAccessKind,
  sessionOwnerKey,
  UNKNOWN_OWNER_KEY,
} from './session-owner-filters';

function session(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: id,
    account_id: 'acc',
    project_id: 'proj',
    status: 'completed',
    created_at: '2026-09-22T08:00:00.000Z',
    updated_at: '2026-09-22T08:00:00.000Z',
    visibility: 'private',
    ...overrides,
  } as ProjectSession;
}

const mine = session('s-mine', { created_by: 'u-me', is_owner: true, owner_name: 'Marko' });
const alice = session('s-alice', {
  created_by: 'u-alice',
  is_owner: false,
  owner_name: 'Alice',
  owner_email: 'alice@example.test',
  visibility: 'project',
});
const alice2 = session('s-alice-2', {
  created_by: 'u-alice',
  is_owner: false,
  owner_name: 'Alice',
  visibility: 'restricted',
});
const bob = session('s-bob', {
  created_by: 'u-bob',
  is_owner: false,
  owner_email: 'bob@example.test',
});
const orphan = session('s-orphan', { created_by: null, is_owner: false });

describe('sessionOwnerKey / sessionAccessKind', () => {
  test('the owner key is created_by, and a missing owner has one stable key', () => {
    expect(sessionOwnerKey(alice)).toBe('u-alice');
    expect(sessionOwnerKey(orphan)).toBe(UNKNOWN_OWNER_KEY);
  });

  test('access kind follows visibility; an absent visibility reads as private', () => {
    expect(sessionAccessKind(alice)).toBe('project');
    expect(sessionAccessKind(alice2)).toBe('restricted');
    expect(sessionAccessKind(session('x', { visibility: undefined }))).toBe('private');
  });
});

describe('matchesOwnerFilters / matchesAccessFilters', () => {
  test('an empty filter matches everything', () => {
    expect(matchesOwnerFilters(alice, [])).toBe(true);
    expect(matchesAccessFilters(alice, [])).toBe(true);
  });

  test('owner filter is an OR over the selected owners', () => {
    expect(matchesOwnerFilters(alice, ['u-alice', 'u-bob'])).toBe(true);
    expect(matchesOwnerFilters(mine, ['u-alice', 'u-bob'])).toBe(false);
    expect(matchesOwnerFilters(orphan, [UNKNOWN_OWNER_KEY])).toBe(true);
  });

  test('access filter is an OR over the selected access kinds', () => {
    expect(matchesAccessFilters(alice, ['project'])).toBe(true);
    expect(matchesAccessFilters(bob, ['project', 'restricted'])).toBe(false);
    expect(matchesAccessFilters(bob, ['private'])).toBe(true);
  });
});

describe('resolveOwnerFacetOptions', () => {
  test('one option per owner, the viewer first, then by name; counts are per owner', () => {
    const options = resolveOwnerFacetOptions([alice, bob, mine, alice2, orphan], []);
    expect(options.map((o) => [o.value, o.count, o.isViewer])).toEqual([
      ['u-me', 1, true],
      ['u-alice', 2, false],
      ['u-bob', 1, false],
      [UNKNOWN_OWNER_KEY, 1, false],
    ]);
    expect(options[1]).toMatchObject({ name: 'Alice', email: 'alice@example.test' });
    expect(options[2]).toMatchObject({ name: null, email: 'bob@example.test' });
  });

  test('a selected owner with no remaining sessions stays listed with count 0', () => {
    const options = resolveOwnerFacetOptions([mine], ['u-alice']);
    expect(options.map((o) => [o.value, o.count])).toEqual([
      ['u-me', 1],
      ['u-alice', 0],
    ]);
  });
});

describe('resolveAccessFacetOptions', () => {
  test('lists only the access kinds present, in a fixed order, with counts', () => {
    const options = resolveAccessFacetOptions([alice, alice2, bob, mine], []);
    expect(options.map((o) => [o.value, o.count])).toEqual([
      ['private', 2],
      ['restricted', 1],
      ['project', 1],
    ]);
  });

  test('a selected access kind with no sessions stays listed with count 0', () => {
    const options = resolveAccessFacetOptions([bob], ['project']);
    expect(options.map((o) => [o.value, o.count])).toEqual([
      ['private', 1],
      ['project', 0],
    ]);
  });
});
