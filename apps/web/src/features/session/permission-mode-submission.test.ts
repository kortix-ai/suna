import { expect, test } from 'bun:test';
import { createPermissionModeSubmission } from './permission-mode-submission';

for (const enabled of [true, false]) {
  test(`permission mode ${enabled} remains unchanged until acknowledgment and retains retry after failure`, async () => {
    let mode = !enabled;
    let reject!: (error: Error) => void;
    const busy: (boolean | null)[] = [];
    const errors: unknown[] = [];
    const submit = createPermissionModeSubmission(
      (value) => busy.push(value),
      (error) => errors.push(error),
    );
    const waiting = new Promise<void>((_, no) => {
      reject = no;
    });
    const first = submit(
      enabled,
      () => waiting,
      () => {
        mode = enabled;
      },
    );
    expect(mode).toBe(!enabled);
    expect(busy).toEqual([enabled]);
    let duplicate = false;
    expect(
      await submit(
        enabled,
        async () => {
          duplicate = true;
        },
        () => {},
      ),
    ).toBe(false);
    expect(duplicate).toBe(false);
    const failure = new Error('Service unavailable');
    reject(failure);
    expect(await first).toBe(false);
    expect(mode).toBe(!enabled);
    expect(errors).toEqual([failure]);
    expect(busy).toEqual([enabled, null]);
    expect(
      await submit(
        enabled,
        async () => {},
        () => {
          mode = enabled;
        },
      ),
    ).toBe(true);
    expect(mode).toBe(enabled);
    expect(busy).toEqual([enabled, null, enabled, null]);
  });
}
