import { describe, expect, test } from 'bun:test';

import { completeThenNotify } from './complete-then';

describe('completeThenNotify', () => {
  // The stamp is already applied to the cache optimistically, so the PATCH has
  // nothing to tell the navigation. Waiting for it showed the "Creating …"
  // loader for a full round trip after the last click.
  test('notifies before the completion settles', async () => {
    let settle!: () => void;
    let notified = false;
    const run = completeThenNotify(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      () => {
        notified = true;
      },
    );
    expect(notified).toBe(true);
    settle();
    await run;
  });

  test('still starts the completion', async () => {
    let completed = false;
    await completeThenNotify(
      async () => {
        completed = true;
      },
      () => undefined,
    );
    expect(completed).toBe(true);
  });

  // THE load-bearing case. The stamp is a PATCH that can fail; the user asked
  // to finish onboarding, not to save a flag. Swallowing the rejection and
  // notifying anyway is what stops a failed stamp from trapping them in a
  // fullscreen modal with no exit. Worst case is one extra wizard render on
  // the project page, which this feature accepts by design.
  test('notifies even when completion REJECTS', async () => {
    let notified = false;
    await completeThenNotify(
      () => Promise.reject(new Error('stamp failed')),
      () => {
        notified = true;
      },
    );
    expect(notified).toBe(true);
  });

  test('does not reject when completion rejects', async () => {
    // `await` is load-bearing: without it the assertion resolves after the test
    // has already returned, and this passes even if the rejection propagates.
    await expect(
      completeThenNotify(() => Promise.reject(new Error('stamp failed')), undefined),
    ).resolves.toBeUndefined();
  });

  test('is a no-op notifier when none is supplied', async () => {
    let completed = false;
    await completeThenNotify(async () => {
      completed = true;
    }, undefined);
    expect(completed).toBe(true);
  });
});
