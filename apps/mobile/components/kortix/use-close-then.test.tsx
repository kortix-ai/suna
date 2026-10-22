/**
 * Characterization tests for the shared close-then slot (`useCloseThen`) —
 * the "close first, then run one thing" dance the session sheets
 * (`AttachSheet`, `PickerSheet`, `SessionActionsSheet`, `useHandoffDismiss`)
 * used to hold as four private copies. The contract, in the sheet's own
 * terms: a follow-up stored in the tap handler right before the dismiss runs
 * exactly once when `onDismiss` fires (the close animation's end), a dismiss
 * that stored nothing — a swipe, a backdrop tap, "Not now" — runs nothing,
 * and a re-open drops a stored action without running it.
 *
 * The hook file imports React only, so this test needs no native-module
 * mocks and cannot poison another test file's module registry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

import { useCloseThen } from './use-close-then';

type CloseThen = ReturnType<typeof useCloseThen<() => void>>;

let handle: CloseThen | null = null;
let payloadHandle: ReturnType<typeof useCloseThen<boolean>> | null = null;
let tree: ReactTestRenderer | undefined;

function Host() {
  handle = useCloseThen();
  return null;
}

function PayloadHost() {
  payloadHandle = useCloseThen<boolean>();
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
});

async function render(): Promise<CloseThen> {
  await act(async () => {
    tree = create(React.createElement(Host));
  });
  if (!handle) throw new Error('useCloseThen returned nothing');
  return handle;
}

async function renderPayload(): Promise<ReturnType<typeof useCloseThen<boolean>>> {
  await act(async () => {
    tree = create(React.createElement(PayloadHost));
  });
  if (!payloadHandle) throw new Error('useCloseThen returned nothing');
  return payloadHandle;
}

async function rerender() {
  const current = tree;
  if (!current) throw new Error('not rendered');
  await act(async () => {
    current.update(React.createElement(Host));
  });
}

describe('useCloseThen — the shared close-then slot', () => {
  test('an action deferred before the dismiss runs exactly once, from onDismiss', async () => {
    const slot = await render();
    let runs = 0;
    slot.deferAfterClose(() => {
      runs += 1;
    });
    // The sheet's onDismiss: one take consumes the stored action.
    slot.takeAfterClose()?.();
    expect(runs).toBe(1);
    // Consumed exactly once: a later dismiss takes and runs nothing.
    expect(slot.takeAfterClose()).toBeNull();
    expect(runs).toBe(1);
  });

  test('a dismiss that stored nothing — a swipe, a backdrop tap — runs nothing', async () => {
    const slot = await render();
    // The sites consume as `takeAfterClose()?.()` — nothing stored, null, no call.
    expect(slot.takeAfterClose()).toBeNull();
  });

  test('a re-open drops a stored action without running it', async () => {
    const slot = await render();
    let runs = 0;
    slot.deferAfterClose(() => {
      runs += 1;
    });
    slot.clearAfterClose();
    slot.takeAfterClose()?.();
    expect(runs).toBe(0);
  });

  test('the slot holds any payload, not only callbacks', async () => {
    const slot = await renderPayload();
    slot.deferAfterClose(true);
    expect(slot.takeAfterClose()).toBe(true);
    expect(slot.takeAfterClose()).toBeNull();
  });

  test('the handle is stable across re-renders', async () => {
    const first = await render();
    await rerender();
    expect(handle).toBe(first);
  });
});
