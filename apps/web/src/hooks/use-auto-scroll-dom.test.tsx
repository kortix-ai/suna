import { afterEach, describe, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useAutoScroll } from './use-auto-scroll';

/**
 * The DOM half of the anchor contract, through the real hook.
 *
 * `pickAnchorIndex` (the pure physics) is pinned in `use-auto-scroll.test.ts`.
 * What only a DOM can pin is the SELECTION `sizeRoom` runs over it: a
 * compaction and the work after it carry `data-turn-continues` and must never
 * become the anchor — anchoring on a running compaction is the reported
 * blank page (KRTX-2565): the marker alone at the top of the screen, the
 * whole conversation above it scrolled out, a large empty room under it.
 *
 * Geometry is stubbed per element (`getBoundingClientRect`, `clientHeight`),
 * so the numbers below are chosen so that the anchored turn CHANGES the
 * spacer: anchoring the continued turn and anchoring the continuation row
 * produce different `spacer.style.height` values. The spacer height is
 * `sizeRoom`'s output — that is what the assertions read.
 */

const win = new Window({ width: 1000, height: 600 });
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  requestAnimationFrame: {
    value: (cb: (t: number) => void) => {
      cb(0);
      return 0;
    },
    configurable: true,
  },
  cancelAnimationFrame: { value: () => {}, configurable: true },
  ResizeObserver: { value: win.ResizeObserver, configurable: true },
  MutationObserver: { value: win.MutationObserver, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

interface Rect {
  top: number;
  height: number;
}

const stubRect = (el: Element, rect: Rect) => {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      top: rect.top,
      bottom: rect.top + rect.height,
      height: rect.height,
      left: 0,
      right: 0,
      width: 0,
      x: rect.top,
      y: rect.top,
      toJSON: () => ({}),
    }),
    configurable: true,
  });
};

/** A viewport that never scrolls: end = scrollHeight − clientHeight = 0. */
const stubViewport = (el: Element, clientHeight: number) => {
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: clientHeight, configurable: true });
};

/** The stubbed geometry of one fixture row. */

interface Row {
  id: string;
  top: number;
  height: number;
  /** Carries `data-turn-continues` (a compaction or the work after it). */
  continues?: boolean;
}

let autoRef: ReturnType<typeof useAutoScroll> | null = null;

function Harness({ rows }: { rows: Row[] }) {
  const auto = useAutoScroll({ hasContent: true });
  // Captured in an effect, not render: the test drives the hook's public
  // methods (scrollToBottom) from outside act() via this module-level ref.
  useEffect(() => {
    autoRef = auto;
  });
  return (
    <div ref={auto.scrollRef} data-test="scroll">
      <div ref={auto.contentRef} data-test="content">
        {rows.map((row) => (
          <div
            key={row.id}
            data-turn-id={row.id}
            data-turn-continues={row.continues ? '' : undefined}
          />
        ))}
        <div ref={auto.spacerElRef} data-test="spacer" />
      </div>
    </div>
  );
}

// DOM values are typed through the global document (lib.dom) while the
// runtime objects are happy-dom's — the same lie every happy-dom test here
// tells (game-of-life.test.tsx). `win` is only for the runtime globals above.
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);

/** Mount the fixture and stub the geometry `sizeRoom` reads. */
function mount(rows: Row[], viewport = 600) {
  act(() => {
    root.render(<Harness rows={rows} />);
  });
  const content = host.querySelector('[data-test="content"]')!;
  const scroll = host.querySelector('[data-test="scroll"]')!;
  stubViewport(scroll, viewport);
  const els = Array.from(content.querySelectorAll('[data-turn-id]'));
  for (const [i, row] of rows.entries()) stubRect(els[i]!, { top: row.top, height: row.height });
  // The spacer lives at the end of the content: its top edge is the content end.
  const end = rows.reduce((max, r) => Math.max(max, r.top + r.height), 0);
  stubRect(content.querySelector('[data-test="spacer"]')!, { top: end, height: 0 });
  return { content, scroll };
}

/** The spacer height after a fresh `sizeRoom` (`scrollToBottom` drives it). */
function spacerHeight(): string | null {
  const spacer = host.querySelector<HTMLElement>('[data-test="spacer"]');
  act(() => autoRef?.scrollToBottom());
  return spacer?.style.height ?? null;
}

const room = (viewport: number, span: number) => Math.max(24, viewport - span - 24);

afterEach(async () => {
  await act(async () => root.render(null));
  autoRef = null;
});

describe('sizeRoom over the real DOM — the anchor never lands on a continuation', () => {
  test('a running compaction under a turn: the anchor stays the continued turn', () => {
    // The recorded shape (KRTX-2565): one prompt answered, then a mid-turn
    // compaction and its continuation. u1 is 300px tall, the marker and the
    // empty continuation ~100px together — content SHORTER than the viewport
    // below the continued turn, so the two anchor choices differ:
    //   u1  → span 400 → room 176 (the fix: the conversation stays in view)
    //   cont → span  40 → room 536 (the bug: the marker alone on a blank page)
    mount([
      { id: 'u1', top: 0, height: 300 },
      { id: 'm1', top: 300, height: 60, continues: true },
      { id: 'm1:continued', top: 360, height: 40, continues: true },
    ]);
    expect(spacerHeight()).toBe(`${room(600, 400)}px`);
  });

  test('the continuation streaming cannot pull the anchor onto itself', () => {
    const rows: Row[] = [
      { id: 'u1', top: 0, height: 300 },
      { id: 'm1', top: 300, height: 60, continues: true },
      { id: 'm1:continued', top: 360, height: 40, continues: true },
    ];
    const { content } = mount(rows);
    expect(spacerHeight()).toBe(`${room(600, 400)}px`);
    // A streaming frame: the continuation grew 100px, the content end moved.
    const cont = content.querySelectorAll('[data-turn-id]')[2]!;
    stubRect(cont, { top: 360, height: 140 });
    stubRect(content.querySelector('[data-test="spacer"]')!, { top: 500, height: 0 });
    //   u1   → span 500 → room  76 (the anchor held)
    //   cont → span 140 → room 436 (re-anchored: the bug again)
    expect(spacerHeight()).toBe(`${room(600, 500)}px`);
  });

  test('a transcript of only compactions still finds an anchor (the fallback list)', () => {
    // `prompts.length ? prompts : all rows` — every row is a continuation
    // (back-to-back compactions keep their own turns), so the filtered list is
    // empty. Anchoring the LAST row is the only choice left.
    mount([
      { id: 'c1', top: 0, height: 60, continues: true },
      { id: 'c2', top: 60, height: 40, continues: true },
    ]);
    expect(spacerHeight()).toBe(`${room(600, 40)}px`);
  });
});
