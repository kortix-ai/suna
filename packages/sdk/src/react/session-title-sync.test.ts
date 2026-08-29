import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';

import { reconcileHydratedSessionTitle } from './session-title-sync';
import { qk } from './query-keys';

const SESSIONS_LIST_KEY = qk.project.sessions('project-1');

function titleQueryClient(initialName: string | null) {
  let name = initialName;
  const refetched: unknown[] = [];
  const list = () => [
    {
      session_id: 'session-1',
      custom_name: null,
      name,
    },
  ];

  return {
    client: {
      getQueryData: (key: readonly unknown[]) =>
        JSON.stringify(key) === JSON.stringify(SESSIONS_LIST_KEY)
          ? list()
          : {
              session_id: 'session-1',
              custom_name: null,
              name,
            },
      refetchQueries: async (input: unknown) => {
        refetched.push(input);
        name = 'Server Generated Title';
      },
    } as unknown as Pick<QueryClient, 'getQueryData' | 'refetchQueries'>,
    refetched,
  };
}

describe('reconcileHydratedSessionTitle', () => {
  test('refetches a titleless session after its user messages hydrate', async () => {
    const { client, refetched } = titleQueryClient(null);

    const resolved = await reconcileHydratedSessionTitle(client, 'project-1', 'session-1', 1, {
      delaysMs: [0],
    });

    expect(resolved).toBe(true);
    expect(refetched).toEqual([
      {
        // The LIST family — every scope ('visible' and the manager-only
        // 'project'), and nothing else. It used to be the whole
        // `sessionsScope` prefix, which ALSO covers `sessionTurn`,
        // `sessionPrompts` and `messages`: seven ladder passes therefore
        // re-issued four endpoints each, and a title refresh became a
        // session-state refetch storm. A title ladder must refetch titles.
        queryKey: [...qk.project.sessionsScope('project-1'), 'list'],
        type: 'active',
      },
      {
        // EXACT: `qk.project.session(...)` is the parent of `prompts` and
        // `turn`, so a prefix refetch here is the same accident again.
        queryKey: qk.project.session('project-1', 'session-1'),
        exact: true,
        type: 'active',
      },
    ]);
    // Stated as its own assertion because it is the whole point of the two
    // keys above: a title pass must never touch the turn or the queue.
    const touched = JSON.stringify(refetched);
    expect(touched).not.toContain('"turn"');
    expect(touched).not.toContain('"prompts"');
  });

  test("keeps refetching Veyris's historical New agent placeholder", async () => {
    const { client, refetched } = titleQueryClient('New agent');

    const resolved = await reconcileHydratedSessionTitle(client, 'project-1', 'session-1', 1, {
      delaysMs: [0],
    });

    expect(resolved).toBe(true);
    expect(refetched).toHaveLength(2);
  });

  test('does not poll an empty conversation or a session that already has a title', async () => {
    const empty = titleQueryClient(null);
    const titled = titleQueryClient('Existing Title');

    expect(
      await reconcileHydratedSessionTitle(empty.client, 'project-1', 'session-1', 0, {
        delaysMs: [0],
      }),
    ).toBe(false);
    expect(
      await reconcileHydratedSessionTitle(titled.client, 'project-1', 'session-1', 1, {
        delaysMs: [0],
      }),
    ).toBe(true);
    expect(empty.refetched).toEqual([]);
    expect(titled.refetched).toEqual([]);
  });
});

describe('the sessions-list refetch defers to an in-flight /start', () => {
  // Regression: an adopted warm session is revealed by /start dropping its
  // `metadata.warm` marker. The ladder's t=0 pass fired a sessions-list
  // refetch that could beat that /start to the server, observe the row still
  // hidden, and overwrite the adopting tab's optimistic seed — the newest
  // session vanished from the sidebar until the next poll. While the start
  // query is fetching, only the detail refetch may run (the detail route
  // serves the owner regardless of the marker).
  function gatedClient(fetchStatus: 'fetching' | 'idle' | undefined) {
    const refetched: unknown[] = [];
    return {
      client: {
        getQueryData: () => undefined,
        getQueryState:
          fetchStatus === undefined
            ? undefined
            : () => ({ fetchStatus }),
        refetchQueries: async (input: unknown) => {
          refetched.push(input);
        },
      } as never,
      refetched,
    };
  }

  test('start query fetching: the list refetch is skipped, the detail refetch still runs', async () => {
    const { client, refetched } = gatedClient('fetching');

    await reconcileHydratedSessionTitle(client, 'project-1', 'session-1', 1, { delaysMs: [0] });

    expect(refetched).toEqual([
      { queryKey: qk.project.session('project-1', 'session-1'), exact: true, type: 'active' },
    ]);
  });

  test('start query settled: both refetches run', async () => {
    const { client, refetched } = gatedClient('idle');

    await reconcileHydratedSessionTitle(client, 'project-1', 'session-1', 1, { delaysMs: [0] });

    expect(refetched).toEqual([
      { queryKey: [...qk.project.sessionsScope('project-1'), 'list'], type: 'active' },
      { queryKey: qk.project.session('project-1', 'session-1'), exact: true, type: 'active' },
    ]);
  });

  test('a client without getQueryState keeps the old behavior', async () => {
    const { client, refetched } = gatedClient(undefined);

    await reconcileHydratedSessionTitle(client, 'project-1', 'session-1', 1, { delaysMs: [0] });

    expect(refetched).toHaveLength(2);
  });
});
