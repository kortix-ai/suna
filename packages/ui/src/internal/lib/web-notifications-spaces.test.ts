import { describe, expect, test } from 'bun:test';
import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';

import { spacesThreadHref } from './web-notifications';

const channel = { space_id: 'sp-general', kind: 'channel', slug: 'general', dm_agent_name: null } as ProjectSpace;
const dm = { space_id: 'sp-dm', kind: 'dm', slug: null, dm_agent_name: 'kortix' } as ProjectSpace;

/** A project whose cache holds its spaces and one loaded thread list per space. */
function cacheWith(threads: Record<string, string[]>) {
  const client = new QueryClient();
  client.setQueryData(qk.project.spaces('p1'), [channel, dm]);
  for (const [spaceId, ids] of Object.entries(threads)) {
    const items = ids.map((id) => ({ session_id: id, space_id: spaceId }) as ProjectSession);
    client.setQueryData(qk.project.sessionsPaged('p1', 'visible', { parent: 'root', spaceId }), {
      pages: [{ items, next_cursor: null }],
      pageParams: [null],
    });
  }
  return client;
}

const at = (pathname: string, search = '') => ({ pathname, search });

describe('spacesThreadHref: a finished turn opens in the thread panel only when it is a thread of the space on screen', () => {
  const cache = cacheWith({ 'sp-general': ['s1'], 'sp-dm': ['s2'] });

  test('a thread of the channel on screen opens in its panel', () => {
    expect(spacesThreadHref(at('/projects/p1/c/general'), { sessionId: 's1', projectId: 'p1' }, cache)).toBe(
      '/projects/p1/c/general?thread=s1',
    );
  });

  test('a thread of the DM on screen keeps the page params and replaces the open thread', () => {
    expect(
      spacesThreadHref(at('/projects/p1/dm/kortix', '?tab=files&thread=old'), { sessionId: 's2', projectId: 'p1' }, cache),
    ).toBe('/projects/p1/dm/kortix?tab=files&thread=s2');
  });

  test('a locale prefix is kept', () => {
    expect(spacesThreadHref(at('/de/projects/p1/c/general'), { sessionId: 's1', projectId: 'p1' }, cache)).toBe(
      '/de/projects/p1/c/general?thread=s1',
    );
  });

  test('a session that is not a thread of the channel on screen keeps its session page', () => {
    expect(spacesThreadHref(at('/projects/p1/c/general'), { sessionId: 's2', projectId: 'p1' }, cache)).toBeNull();
    expect(spacesThreadHref(at('/projects/p1/c/general'), { sessionId: 'loose', projectId: 'p1' }, cache)).toBeNull();
  });

  test("another project's session never opens in this project's channel", () => {
    expect(spacesThreadHref(at('/projects/p1/c/general'), { sessionId: 's1', projectId: 'p2' }, cache)).toBeNull();
    expect(spacesThreadHref(at('/projects/p1/c/general'), { sessionId: 's1', projectId: null }, cache)).toBeNull();
  });

  test('any other page has no thread panel', () => {
    expect(spacesThreadHref(at('/projects/p1/sessions/s1'), { sessionId: 's1', projectId: 'p1' }, cache)).toBeNull();
    expect(spacesThreadHref(at('/projects/p1'), { sessionId: 's1', projectId: 'p1' }, cache)).toBeNull();
  });
});
