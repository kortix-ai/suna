import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

import { LeaveGuardProvider, useGuardedLeave, useUnsavedChangesGuard } from './leave-guard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// The guard arms `beforeunload` and a capture-phase click listener while
// dirty. The bun process has no DOM: stub the two listener targets.
const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document };
const target = { addEventListener: () => undefined, removeEventListener: () => undefined };
beforeAll(() => {
  g.window ??= target;
  g.document ??= target;
});
afterAll(() => {
  g.window = saved.window;
  g.document = saved.document;
});

type Guard = ReturnType<typeof useUnsavedChangesGuard>;

/** The agent editor's shape: the page owns the guard, an embedded screen exits. */
function Page({
  dirty,
  expose,
  children,
}: {
  dirty: boolean;
  expose: (guard: Guard) => void;
  children?: ReactNode;
}) {
  const guard = useUnsavedChangesGuard(dirty, '/projects/p/customize/agents/a');
  expose(guard);
  return createElement(LeaveGuardProvider, { value: guard.confirmLeave }, children);
}

function Screen({ expose }: { expose: (leave: (go: () => void) => void) => void }) {
  expose(useGuardedLeave());
  return null;
}

function mount(dirty: boolean) {
  let guard!: Guard;
  let leave!: (go: () => void) => void;
  act(() => {
    create(
      createElement(
        Page,
        { dirty, expose: (next: Guard) => (guard = next) },
        createElement(Screen, { expose: (next) => (leave = next) }),
      ),
    );
  });
  return { guard: () => guard, leave: () => leave };
}

describe('leave guard', () => {
  test('a dirty page parks a programmatic exit and asks; leaving runs it', () => {
    const go = mock(() => undefined);
    const page = mount(true);
    act(() => page.leave()(go));
    expect(go).not.toHaveBeenCalled();
    expect(page.guard().asking).toBe(true);
    act(() => page.guard().leave());
    expect(go).toHaveBeenCalledTimes(1);
    expect(page.guard().asking).toBe(false);
  });

  test('staying drops the parked exit', () => {
    const go = mock(() => undefined);
    const page = mount(true);
    act(() => page.leave()(go));
    act(() => page.guard().stay());
    expect(page.guard().asking).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  test('a clean page exits at once', () => {
    const go = mock(() => undefined);
    const page = mount(false);
    act(() => page.leave()(go));
    expect(go).toHaveBeenCalledTimes(1);
    expect(page.guard().asking).toBe(false);
  });

  test('outside a guarded page the exit runs at once', () => {
    const go = mock(() => undefined);
    let leave!: (go: () => void) => void;
    act(() => {
      create(createElement(Screen, { expose: (next) => (leave = next) }));
    });
    leave(go);
    expect(go).toHaveBeenCalledTimes(1);
  });
});
