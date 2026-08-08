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
        // The broad sessions-family prefix (list, every scope, every
        // session/messages entry) — NOT the exact list key `getQueryData`
        // reads above. See `qk.project.sessionsScope`'s doc comment.
        queryKey: qk.project.sessionsScope('project-1'),
        type: 'active',
      },
      {
        queryKey: qk.project.session('project-1', 'session-1'),
        type: 'active',
      },
    ]);
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
