import { describe, expect, test } from 'bun:test';

import { refetchKortixSessionMirrors } from './helpers';
import { qk } from '../query-keys';

function fakeQueryClient() {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      refetchQueries: (input: unknown) => {
        calls.push(input);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof refetchKortixSessionMirrors>[0],
  };
}

describe('refetchKortixSessionMirrors', () => {
  // Pre-migration this refetched a BARE, id-less flat `project-sessions`
  // array prefix, which matched every mounted project's sessions list.
  // `qk.project.scope(id)` requires an id up front, so there is no key that
  // means "sessions, any project" without also reaching every OTHER
  // project-scoped family for every project. Scoping to the route's project
  // (what the SSE connection is actually about) is the correct reach — see
  // the function's doc comment in `helpers.ts`.
  test('refetches the sessions-family prefix for the given project only', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, 'proj_1');
    expect(calls).toEqual([
      { queryKey: qk.project.sessionsScope('proj_1'), type: 'active' },
    ]);
  });

  test('does nothing outside a project route (workspaceId null)', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, null);
    expect(calls).toEqual([]);
  });

  // A different project's sessions prefix must never be touched by an event
  // about THIS project — the whole reason this isn't the old bare "any
  // project" prefix.
  test('never reaches a different project\'s sessions prefix', () => {
    const { client, calls } = fakeQueryClient();
    refetchKortixSessionMirrors(client, 'proj_1');
    const [call] = calls as Array<{ queryKey: readonly unknown[] }>;
    expect(call.queryKey).not.toEqual(qk.project.sessionsScope('proj_2'));
  });
});
