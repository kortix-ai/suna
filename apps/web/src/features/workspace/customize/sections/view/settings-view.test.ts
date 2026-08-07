import { describe, expect, test } from 'bun:test';

import { runProjectArchive, type RunProjectArchiveClient } from './settings-view';

/**
 * `runProjectArchive` is the archive mutation's real side effects, extracted
 * so this test can inject a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — see the function's own doc comment for
 * why that matters in this monorepo.
 *
 * These pin the exact contract the deleted `/projects` list page's archive
 * handler carried: suppress auto-recreate only when this was the account's
 * last active project, only after the archive call itself succeeds, and
 * never on failure — proven by counting real invocations of the injected
 * `onSuppress` spy, not by asserting a symbol appears in the source.
 */
describe('runProjectArchive', () => {
  function client(overrides: Partial<RunProjectArchiveClient> = {}): RunProjectArchiveClient {
    return {
      archiveProject: async () => undefined,
      ...overrides,
    };
  }

  test('suppresses auto-recreate when this was the account\'s last active project', async () => {
    let suppressCalls = 0;
    await runProjectArchive('p1', 1, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(1);
  });

  test('also suppresses when the account was already down to zero', async () => {
    // Defensive: an already-empty account (e.g. a stale count) must not skip
    // the guard just because the arithmetic edge is unusual.
    let suppressCalls = 0;
    await runProjectArchive('p1', 0, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(1);
  });

  test('does NOT suppress when other active projects remain in the account', async () => {
    let suppressCalls = 0;
    await runProjectArchive('p1', 3, client(), () => {
      suppressCalls += 1;
    });
    expect(suppressCalls).toBe(0);
  });

  test('does NOT suppress when the archive call itself fails', async () => {
    // A failed archive leaves the project alive — suppressing here would
    // wrongly block auto-provision for a project that still exists.
    let suppressCalls = 0;
    const failing = client({
      archiveProject: async () => {
        throw new Error('archive failed');
      },
    });

    await expect(
      runProjectArchive('p1', 1, failing, () => {
        suppressCalls += 1;
      }),
    ).rejects.toThrow('archive failed');
    expect(suppressCalls).toBe(0);
  });

  test('calls archiveProject with the given project id', async () => {
    const calls: string[] = [];
    await runProjectArchive(
      'the-project-id',
      1,
      client({
        archiveProject: async (projectId) => {
          calls.push(projectId);
        },
      }),
      () => {},
    );
    expect(calls).toEqual(['the-project-id']);
  });

  test('suppression fires strictly after archiveProject resolves, not before', async () => {
    // Ordering matters: onSuppress must observe a completed archive, never a
    // still-in-flight one.
    const events: string[] = [];
    await runProjectArchive(
      'p1',
      1,
      client({
        archiveProject: async () => {
          events.push('archived');
        },
      }),
      () => events.push('suppressed'),
    );
    expect(events).toEqual(['archived', 'suppressed']);
  });
});
