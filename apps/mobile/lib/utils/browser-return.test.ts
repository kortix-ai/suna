import { describe, expect, test } from 'bun:test';

import { waitForForegroundReturn, type AppStateSubscribe } from './browser-return';

function fakeAppState() {
  let listener: ((state: string) => void) | null = null;
  let removed = false;
  const subscribe: AppStateSubscribe = (fn) => {
    listener = fn;
    return { remove: () => { removed = true; listener = null; } };
  };
  return {
    subscribe,
    emit: (state: string) => listener?.(state),
    get removed() { return removed; },
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('waitForForegroundReturn', () => {
  test('resolves only after the app leaves the foreground and comes back', async () => {
    const app = fakeAppState();
    const wait = waitForForegroundReturn(app.subscribe).returned;
    expect(await settled(wait)).toBe(false);
    app.emit('background');
    expect(await settled(wait)).toBe(false);
    app.emit('active');
    expect(await settled(wait)).toBe(true);
    expect(app.removed).toBe(true);
  });

  test('an "active" event before the app ever left does not resolve it', async () => {
    const app = fakeAppState();
    const wait = waitForForegroundReturn(app.subscribe).returned;
    app.emit('active');
    expect(await settled(wait)).toBe(false);
    app.emit('inactive');
    app.emit('active');
    expect(await settled(wait)).toBe(true);
  });

  test('cancel removes the listener', () => {
    const app = fakeAppState();
    waitForForegroundReturn(app.subscribe).cancel();
    expect(app.removed).toBe(true);
  });
});
