import { describe, expect, test } from 'bun:test';

import { createTurnAnchor, type TurnAnchorDeps } from './turn-anchor';

/** A hand-driven frame scheduler — no rAF, no timers, no flakiness. */
function harness(present: Set<string> = new Set()) {
  const queue: Array<() => void> = [];
  const anchored: string[] = [];
  const deps: TurnAnchorDeps<string> = {
    find: (id) => (present.has(id) ? id : null),
    anchor: (el) => anchored.push(el),
    schedule: (fn) => {
      queue.push(fn);
      return () => {
        const i = queue.indexOf(fn);
        if (i !== -1) queue.splice(i, 1);
      };
    },
  };
  /** Advance exactly one frame. */
  const frame = () => {
    const next = queue.shift();
    next?.();
  };
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) frame();
  };
  return { deps, anchored, frame, frames, present, pending: () => queue.length };
}

describe('createTurnAnchor', () => {
  test('anchors in the same frame when the turn is already committed', () => {
    const h = harness(new Set(['turn_a']));
    createTurnAnchor(h.deps).request('turn_a');

    // No wait, no intermediate position to see.
    expect(h.anchored).toEqual(['turn_a']);
    expect(h.pending()).toBe(0);
  });

  test('waits for a turn that has not rendered yet, then anchors once', () => {
    const h = harness();
    createTurnAnchor(h.deps).request('turn_a');

    expect(h.anchored).toEqual([]);
    h.frames(3);
    expect(h.anchored).toEqual([]);

    // React commits.
    h.present.add('turn_a');
    h.frame();

    expect(h.anchored).toEqual(['turn_a']);
  });

  test('anchors exactly once, never on every subsequent frame', () => {
    const h = harness();
    createTurnAnchor(h.deps).request('turn_a');
    h.present.add('turn_a');
    h.frames(10);

    expect(h.anchored).toEqual(['turn_a']);
    expect(h.pending()).toBe(0);
  });

  test('gives up rather than leaving a scroll primed forever', () => {
    // The old `setTimeout` fired into whatever the viewport looked like 100ms
    // later, unconditionally. A turn that never arrives must not leave an
    // anchor waiting to pounce.
    const h = harness();
    createTurnAnchor(h.deps, { maxFrames: 5 }).request('turn_never');

    h.frames(20);
    expect(h.anchored).toEqual([]);
    expect(h.pending()).toBe(0);
  });

  test('abandon stops a pending anchor — the reader took over', () => {
    const h = harness();
    const anchorer = createTurnAnchor(h.deps);
    anchorer.request('turn_a');

    anchorer.abandon();
    h.present.add('turn_a');
    h.frames(10);

    expect(h.anchored).toEqual([]);
  });

  test('abandon after the anchor already landed is a harmless no-op', () => {
    const h = harness(new Set(['turn_a']));
    const anchorer = createTurnAnchor(h.deps);
    anchorer.request('turn_a');
    anchorer.abandon();

    expect(h.anchored).toEqual(['turn_a']);
  });

  test('a second request supersedes the first instead of racing it', () => {
    // Two sends in quick succession must land on the second.
    const h = harness();
    const anchorer = createTurnAnchor(h.deps);
    anchorer.request('turn_a');
    anchorer.request('turn_b');

    h.present.add('turn_a');
    h.present.add('turn_b');
    h.frames(10);

    expect(h.anchored).toEqual(['turn_b']);
  });

  test('each request gets its own frame budget, not the previous one leftovers', () => {
    const h = harness();
    const anchorer = createTurnAnchor(h.deps, { maxFrames: 3 });

    // Burn the first request's budget to exhaustion.
    anchorer.request('turn_a');
    h.frames(5);
    expect(h.pending()).toBe(0);

    // A fresh request must start from a full budget. If it inherited the
    // spent count it would give up immediately and never anchor.
    anchorer.request('turn_b');
    h.frame();
    h.present.add('turn_b');
    h.frame();

    expect(h.anchored).toEqual(['turn_b']);
  });
});
