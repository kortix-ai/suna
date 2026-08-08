import { describe, expect, test } from 'bun:test';

import { completeThenNotify } from './complete-then';

describe('completeThenNotify', () => {
  test('awaits the completion, then notifies', async () => {
    const order: string[] = [];
    await completeThenNotify(
      async () => {
        order.push('complete');
      },
      () => order.push('notify'),
    );
    expect(order).toEqual(['complete', 'notify']);
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
    expect(
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
