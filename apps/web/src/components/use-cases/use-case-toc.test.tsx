import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { UseCaseToc, type TocItem } from './use-case-toc';

/**
 * The toc's scroll-spy must track the section the reader is in. The observer
 * only reports intersection-state CHANGES, so the spy has to keep membership
 * (who is inside the band) and pick the topmost member live — the same
 * semantics `useActiveSection` (doc-rail) already implements. A spy that only
 * reacts to "intersecting" arrivals sticks to whichever section last crossed
 * the band: a section that merely enters while the reader is still inside the
 * previous one steals the highlight for the rest of the visit.
 */

const win = new Window();
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

type SpyEntry = { isIntersecting: boolean; target: Element };
type SpyObserver = { callback: (entries: SpyEntry[]) => void; options?: IntersectionObserverInit };

const savedObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
let spies: SpyObserver[] = [];
let root: Root | null = null;

beforeEach(() => {
  spies = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(callback: (entries: SpyEntry[]) => void, options?: IntersectionObserverInit) {
      spies.push({ callback, options });
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.render(null));
  root = null;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedObserver;
  document.body.innerHTML = '';
});

/** A section element the spy can observe, with a controllable viewport top. */
function section(id: string, top: number): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ top }),
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

function mountToc(items: TocItem[]): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
  act(() => {
    root!.render(<UseCaseToc items={items} />);
  });
}

/** The id whose toc link currently carries the active classes. */
function activeId(ids: readonly string[]): string {
  for (const id of ids) {
    const link = document.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`);
    if (link?.className.split(' ').includes('font-medium')) return id;
  }
  return '';
}

describe('UseCaseToc scroll-spy', () => {
  const items: TocItem[] = [
    { title: 'Alpha', url: '#alpha', depth: 2 },
    { title: 'Beta', url: '#beta', depth: 2 },
  ];
  const ids = ['alpha', 'beta'];

  test('the highlight follows the topmost section in the band instead of sticking to the last arrival', async () => {
    const alpha = section('alpha', 100);
    const beta = section('beta', 500);
    mountToc(items);
    const spy = spies.at(-1);
    if (!spy) throw new Error('the toc never subscribed an IntersectionObserver');

    // Alpha enters the band: it is the only member, so it lights up.
    await act(async () => spy.callback([{ isIntersecting: true, target: alpha }]));
    expect(activeId(ids)).toBe('alpha');

    // Beta enters while alpha is still in the band. The reader is still inside
    // alpha (the topmost member), so the highlight must not move to beta.
    await act(async () => spy!.callback([{ isIntersecting: true, target: beta }]));
    expect(activeId(ids)).toBe('alpha');

    // Alpha leaves the band: the highlight follows beta.
    await act(async () => spy!.callback([{ isIntersecting: false, target: alpha }]));
    expect(activeId(ids)).toBe('beta');
  });

  test('the toc keeps its own observation band', () => {
    section('alpha', 100);
    mountToc(items);
    expect(spies.at(-1)?.options?.rootMargin).toBe('-88px 0px -70% 0px');
  });
});
