import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import { useReminderTab } from './use-reminder-tab';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// KRTX-2888: the List view is one reminders query filtered per tab, so a
// reminder paused from the CLI stayed under Active, and Paused read "Nothing
// paused", until a full reload. Switching tabs now refetches.
test('switching the state tab refetches the reminders', async () => {
  let refetches = 0;
  let current: ReturnType<typeof useReminderTab> | null = null;
  function Probe() {
    current = useReminderTab(() => {
      refetches += 1;
    });
    return null;
  }
  await act(async () => {
    create(createElement(Probe));
  });
  expect(current![0]).toBe('active');
  expect(refetches).toBe(0);

  await act(async () => current![1]('paused'));
  expect(current![0]).toBe('paused');
  expect(refetches).toBe(1);

  await act(async () => current![1]('active'));
  expect(refetches).toBe(2);
});
