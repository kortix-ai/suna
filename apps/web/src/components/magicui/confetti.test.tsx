/**
 * Characterization for the surviving `<Confetti>` contract, written before the
 * unused `useConfetti`/`ConfettiButton`/`ConfettiContext` layer was removed.
 * The component has exactly one consumer (`ui/identity-confetti.tsx`), which
 * drives it through the automatic mount burst and the imperative ref, so this
 * pins the behaviors that consumer relies on.
 *
 * The canvas callback ref only receives a node from a real DOM, so these run
 * through `react-dom/client` on happy-dom, with `canvas-confetti` mocked at
 * the module boundary.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

const createdGlobals: unknown[] = [];
const shots: Record<string, unknown>[] = [];
let resetCalls = 0;

const fakeInstance = ((options: Record<string, unknown> = {}) => {
  shots.push(options);
  return Promise.resolve();
}) as ((options?: Record<string, unknown>) => Promise<void>) & { reset: () => void };
fakeInstance.reset = () => {
  resetCalls += 1;
};

mock.module('canvas-confetti', () => {
  const confetti = (options: Record<string, unknown> = {}) => {
    shots.push(options);
    return Promise.resolve();
  };
  (confetti as unknown as { create: unknown }).create = () => {
    createdGlobals.push(true);
    return fakeInstance;
  };
  return { default: confetti, __esModule: true };
});

// The component under test, imported after the mock so it binds the stub.
const confettiModule = await import('./confetti');
const Confetti = confettiModule.Confetti;
type ConfettiRef = (typeof confettiModule)['ConfettiRef'];

let roots: Root[] = [];
let containers: Element[] = [];

async function mount(node: React.ReactElement) {
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(node);
  });
  return { root, container };
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await act(async () => {
      root.unmount();
    });
  for (const container of containers.splice(0)) container.remove();
  shots.length = 0;
  createdGlobals.length = 0;
  resetCalls = 0;
});

test('a plain mount fires once with the reduced-motion default and the overlay canvas', async () => {
  const { container } = await mount(createElement(Confetti));
  expect(createdGlobals).toHaveLength(1);
  expect(shots).toHaveLength(1);
  // Reduced motion is the component's own default, not a caller's job.
  expect(shots[0].disableForReducedMotion).toBe(true);
  // The canvas defaults to a full-viewport, click-through overlay.
  const canvas = container.querySelector('canvas');
  expect(canvas).not.toBeNull();
  expect(canvas!.getAttribute('aria-hidden')).toBe('true');
  const cls = canvas!.getAttribute('class') ?? '';
  for (const part of ['pointer-events-none', 'fixed', 'inset-0', 'z-50', 'size-full']) {
    expect(cls).toContain(part);
  }
});

test('manualstart holds the burst until ref.fire, and a per-shot option wins over the component options', async () => {
  const holder: { ref: React.RefObject<ConfettiRef> | null } = { ref: null };
  function Host() {
    const r = useRef<ConfettiRef>(null);
    holder.ref = r;
    return createElement(Confetti, {
      ref: r,
      manualstart: true,
      options: { particleCount: 80, colors: ['#000000'] },
    });
  }
  await mount(createElement(Host));
  expect(shots).toHaveLength(0);
  await act(async () => {
    holder.ref!.current?.fire({ particleCount: 10, spread: 120 });
  });
  expect(shots).toHaveLength(1);
  // Precedence: the per-shot argument > the component's options > the
  // reduced-motion default the component itself owns.
  expect(shots[0].particleCount).toBe(10);
  expect(shots[0].spread).toBe(120);
  expect(shots[0].colors).toEqual(['#000000']);
  expect(shots[0].disableForReducedMotion).toBe(true);
});

test('a mount burst honours component options over the reduced-motion default', async () => {
  await mount(createElement(Confetti, { options: { particleCount: 42 } }));
  expect(shots).toHaveLength(1);
  expect(shots[0].particleCount).toBe(42);
  expect(shots[0].disableForReducedMotion).toBe(true);
});

test('unmount resets the canvas instance, so a burst never outlives its node', async () => {
  const { root } = await mount(createElement(Confetti, { manualstart: true }));
  expect(createdGlobals).toHaveLength(1);
  expect(resetCalls).toBe(0);
  await act(async () => {
    root.unmount();
  });
  expect(resetCalls).toBe(1);
});
