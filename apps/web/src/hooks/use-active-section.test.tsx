import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useActiveSection } from './use-active-section';

/**
 * Semantics of the shared scroll-spy (serves the doc rail and the use-case
 * toc). The observer only reports intersection-state CHANGES, so the hook
 * keeps a membership set of the ids inside the band and picks the topmost
 * member live, at decision time — never from offsets carried by an entry,
 * which go stale the moment the reader scrolls on.
 */

const win = new Window();
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

type SpyEntry = { isIntersecting: boolean; target: Element };
type SpyObserver = { callback: (entries: SpyEntry[]) => void };

const savedObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
let spies: SpyObserver[] = [];
let root: Root | null = null;

beforeEach(() => {
  spies = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(callback: (entries: SpyEntry[]) => void) {
      spies.push({ callback });
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

/** The hook's return is rendered into the DOM so tests read it like any other
 * render output — no module-level state for a component to mutate. */
function Harness({ ids, rootMargin }: { ids: readonly string[]; rootMargin: string }) {
  const active = useActiveSection(ids, { rootMargin });
  return <div data-testid="active" data-active={active} />;
}

function activeSection(): string {
  return document.querySelector('[data-testid="active"]')?.getAttribute('data-active') ?? '';
}

function mount(ids: string[]): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
  act(() => {
    const mounted = root;
    if (!mounted) throw new Error('the React root was not created');
    mounted.render(<Harness ids={ids} rootMargin="-96px 0px -55% 0px" />);
  });
}

async function fire(...entries: SpyEntry[]): Promise<void> {
  const spy = spies.at(-1);
  if (!spy) throw new Error('the hook never subscribed an IntersectionObserver');
  await act(async () => spy.callback(entries));
}

describe('useActiveSection', () => {
  test('the first section is active before the first intersection event', () => {
    section('alpha', 100);
    section('beta', 500);
    mount(['alpha', 'beta']);
    expect(activeSection()).toBe('alpha');
  });

  test('the topmost member wins, read live at decision time — not the newest arrival', async () => {
    const alpha = section('alpha', 100);
    const beta = section('beta', 500);
    mount(['alpha', 'beta']);

    // Beta enters while alpha is still in the band: the reader is still inside
    // alpha, the topmost member.
    await fire({ isIntersecting: true, target: alpha });
    await fire({ isIntersecting: true, target: beta });
    expect(activeSection()).toBe('alpha');

    // Layout moves alpha below beta without a new alpha intersection event.
    // Cached entry offsets still pick alpha; live positions must pick beta.
    Object.defineProperty(alpha, 'getBoundingClientRect', {
      value: () => ({ top: 600 }),
      configurable: true,
    });
    await fire({ isIntersecting: true, target: beta });
    expect(activeSection()).toBe('beta');
  });

  test('membership ends on exit, so the remaining member takes over', async () => {
    const alpha = section('alpha', 100);
    const beta = section('beta', 500);
    mount(['alpha', 'beta']);

    await fire({ isIntersecting: true, target: alpha });
    await fire({ isIntersecting: true, target: beta });
    expect(activeSection()).toBe('alpha');

    await fire({ isIntersecting: false, target: alpha });
    expect(activeSection()).toBe('beta');
  });

  test('an empty band keeps the last pick until a section enters again', async () => {
    const alpha = section('alpha', 100);
    mount(['alpha']);
    await fire({ isIntersecting: true, target: alpha });
    expect(activeSection()).toBe('alpha');
    await fire({ isIntersecting: false, target: alpha });
    expect(activeSection()).toBe('alpha');
  });
});
