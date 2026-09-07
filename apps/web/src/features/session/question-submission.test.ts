import { describe, expect, test } from 'bun:test';
import { createQuestionSubmission } from './question-submission';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('question submission', () => {
  test('keeps submission pending until acknowledgment and refuses duplicate clicks', async () => {
    const busy: boolean[] = [];
    const errors: unknown[] = [];
    const run = createQuestionSubmission(
      (value) => busy.push(value),
      (error) => errors.push(error),
    );
    const gate = deferred();
    let calls = 0;
    const first = run(() => {
      calls++;
      return gate.promise;
    });
    expect(busy).toEqual([true]);
    expect(
      await run(() => {
        calls++;
      }),
    ).toBe(false);
    expect(calls).toBe(1);
    gate.resolve();
    expect(await first).toBe(true);
    expect(busy).toEqual([true, false]);
    expect(errors).toEqual([]);
  });
  test('reports failure, releases the busy state, and accepts a retry', async () => {
    const busy: boolean[] = [];
    const errors: unknown[] = [];
    const run = createQuestionSubmission(
      (value) => busy.push(value),
      (error) => errors.push(error),
    );
    const failure = new Error('Service unavailable');
    const gate = deferred();
    const first = run(() => gate.promise);
    gate.reject(failure);
    expect(await first).toBe(false);
    expect(errors).toEqual([failure]);
    expect(busy).toEqual([true, false]);
    expect(await run(async () => {})).toBe(true);
    expect(busy).toEqual([true, false, true, false]);
  });
  test('a synchronous handler failure also leaves the interaction retryable', async () => {
    const busy: boolean[] = [];
    const errors: unknown[] = [];
    const run = createQuestionSubmission(
      (value) => busy.push(value),
      (error) => errors.push(error),
    );
    const failure = new Error('Rejected');
    expect(
      await run(() => {
        throw failure;
      }),
    ).toBe(false);
    expect(errors).toEqual([failure]);
    expect(busy).toEqual([true, false]);
    expect(await run(() => {})).toBe(true);
  });
});
