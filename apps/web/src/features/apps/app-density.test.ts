import { expect, test } from 'bun:test';
import { APP_GRID_COLUMNS_STORAGE_KEY, readAppGridColumns, subscribeAppGridColumns, writeAppGridColumns } from './app-density';

test('density reads storage, notifies subscribers, unsubscribes, and retains blocked writes', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  const values = new Map<string, string>([[APP_GRID_COLUMNS_STORAGE_KEY, '4']]);
  let blocked = false;
  let readBlocked = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => { if (readBlocked) throw new Error('Read blocked'); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error('Storage blocked');
        values.set(key, value);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  let notifications = 0;
  const unsubscribe = subscribeAppGridColumns(() => { notifications++; });
  try {
    expect(readAppGridColumns()).toBe(4);
    readBlocked = true;
    expect(readAppGridColumns()).toBe(3);
    readBlocked = false;
    values.set(APP_GRID_COLUMNS_STORAGE_KEY, 'invalid');
    expect(readAppGridColumns()).toBe(3);
    events.dispatchEvent(new Event('storage'));
    expect(notifications).toBe(1);
    writeAppGridColumns(3);
    expect(notifications).toBe(2);
    expect(values.get(APP_GRID_COLUMNS_STORAGE_KEY)).toBe('3');
    blocked = true;
    writeAppGridColumns(4);
    expect(readAppGridColumns()).toBe(4);
    expect(values.get(APP_GRID_COLUMNS_STORAGE_KEY)).toBe('3');
    expect(notifications).toBe(3);
    unsubscribe();
    events.dispatchEvent(new Event('storage'));
    writeAppGridColumns(3);
    expect(notifications).toBe(3);
  } finally {
    unsubscribe();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
