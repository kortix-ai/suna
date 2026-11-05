import { afterEach, expect, mock, test } from 'bun:test';
import { createDeepLinkScope } from './deep-link-scope';

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

test('disposed deep links cannot navigate, allocate another timer, or leave an awaited delay pending', async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  globalThis.setTimeout = ((callback: () => void) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const scope = createDeepLinkScope();
  const navigate = mock(() => {});
  scope.schedule(navigate, 500);
  const queued = [...timers.values()][0];
  const paused = scope.pause(100).then((active) => { if (active) navigate(); });
  expect(timers.size).toBe(2);
  scope.dispose();
  expect(scope.active).toBe(false);
  expect(timers.size).toBe(0);
  queued();
  scope.schedule(navigate, 500);
  await paused;
  expect(await scope.pause(100)).toBe(false);
  expect(timers.size).toBe(0);
  expect(navigate).not.toHaveBeenCalled();
});
