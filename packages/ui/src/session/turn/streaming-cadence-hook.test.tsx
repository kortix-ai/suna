/**
 * `useStreamingCadence` on mount (KRTX-2932): text the client already holds
 * shows at full length on every mount, and a remount mid-stream resumes from
 * the length the reader had already seen. Runs the hook against `happy-dom`,
 * the pattern of `features/review-center/review-center-verdicts.test.tsx`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;

const { useStreamingCadence } = await import('./streaming-cadence');
type PacerClock = import('./streaming-cadence').PacerClock;

/** A manual frame clock: frames run only when the test advances it. */
function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const clock: PacerClock = {
    now: () => now,
    requestFrame: (fn) => {
      frames.set(nextId, fn);
      return nextId++;
    },
    cancelFrame: (id) => void frames.delete(id as number),
    hidden: () => false,
  };
  return {
    clock,
    advance(ms: number) {
      const until = now + ms;
      while (now + 16 <= until) {
        now += 16;
        const due = [...frames.values()];
        frames.clear();
        for (const fn of due) act(fn);
      }
      now = until;
    },
  };
}

let root: Root | null = null;
let rendered: { text: string; streaming: boolean }[] = [];

function Probe(props: { value: string; active: boolean; revealKey?: string; clock: PacerClock }) {
  rendered.push(useStreamingCadence(props.value, props.active, props.revealKey, props.clock));
  return null;
}

function mount(props: Parameters<typeof Probe>[0]) {
  rendered = [];
  root = createRoot(document.createElement('div') as unknown as HTMLElement);
  act(() => root!.render(<Probe {...props} />));
}
function update(props: Parameters<typeof Probe>[0]) {
  act(() => root!.render(<Probe {...props} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const words = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ');

describe('useStreamingCadence on mount', () => {
  test('a short reply that mounts mid-stream shows in full on the first render, never re-typed', () => {
    const t = fakeClock();
    const text = `${words(12)} `;
    mount({ value: text, active: true, revealKey: 'm1:p1', clock: t.clock });
    expect(rendered[0].text).toBe(text);
    t.advance(500);
    expect(rendered.every((r) => r.text === text)).toBe(true);
  });

  test('a remount mid-stream resumes from the length the reader had seen', () => {
    const t = fakeClock();
    const start = `${words(5)} `;
    const full = `${start}${words(80, 5)} `;
    mount({ value: start, active: true, revealKey: 'm2:p1', clock: t.clock });
    update({ value: full, active: true, revealKey: 'm2:p1', clock: t.clock });
    t.advance(96);
    const seen = rendered.at(-1)!.text.length;
    expect(seen).toBeGreaterThan(start.length);
    expect(seen).toBeLessThan(full.length);

    act(() => root!.unmount());
    mount({ value: full, active: true, revealKey: 'm2:p1', clock: t.clock });
    expect(rendered[0].text.length).toBe(seen);
    t.advance(2000);
    expect(rendered.at(-1)!.text).toBe(full);
  });

  test('a remount long after the last reveal shows the full text', () => {
    const t = fakeClock();
    const start = `${words(5)} `;
    const full = `${start}${words(80, 5)} `;
    mount({ value: start, active: true, revealKey: 'm3:p1', clock: t.clock });
    update({ value: full, active: true, revealKey: 'm3:p1', clock: t.clock });
    t.advance(96);
    act(() => root!.unmount());
    t.advance(5_000);
    mount({ value: full, active: true, revealKey: 'm3:p1', clock: t.clock });
    expect(rendered[0].text).toBe(full);
  });
});
