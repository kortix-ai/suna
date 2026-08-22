/**
 * A browser-shaped global for `react-dom/client` under bun:test.
 *
 * `apps/web` has no DOM harness — every other component test renders with
 * `renderToStaticMarkup`, which cannot re-render. The render-counter test
 * needs a live root, so it gets one here from `happy-dom` (the ONLY
 * devDependency added for the timeline work). Import this module FIRST: it
 * installs `window`, `document` and the observer stubs the transcript's
 * components touch on mount.
 *
 * `bun test <dir>` runs every file of the directory in ONE process, so these
 * globals would leak into every later file — the composer's tiptap tests
 * measurably change behaviour with a `document` present. Call
 * `uninstallDom()` from `afterAll` to put the process back exactly as found.
 *
 * NOT an `act` environment on purpose. `TurnFrame` runs 1s tickers for the
 * working turn; React's async `act` keeps draining its queue while those
 * intervals enqueue work, so `await act(...)` over a working turn never
 * resolves. The render-counter test renders through a plain root and waits
 * a few macrotasks instead.
 */
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
const w = window as unknown as Record<string, unknown>;

/** Every global this module wrote, with what was there before (`undefined`
 *  for "absent"), so `uninstallDom` restores the exact prior state. */
const installed: { key: string; previous: unknown; had: boolean }[] = [];

function install(key: string, value: unknown): void {
  installed.push({ key, previous: g[key], had: key in g });
  g[key] = value;
}

install('window', window);
install('document', window.document);
install('navigator', window.navigator);

for (const key of [
  'customElements',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'SVGElement',
  'Element',
  'Node',
  'Text',
  'Comment',
  'DocumentFragment',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'DOMRect',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
  'sessionStorage',
  'CSS',
]) {
  if (g[key] === undefined && key in w) {
    const value = w[key];
    install(
      key,
      typeof value === 'function' && !/^[A-Z]/.test(key)
        ? (value as (...args: unknown[]) => unknown).bind(window)
        : value,
    );
  }
}

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}
if (g.ResizeObserver === undefined) install('ResizeObserver', ObserverStub);
if (g.IntersectionObserver === undefined) install('IntersectionObserver', ObserverStub);
w.ResizeObserver ??= ObserverStub;
w.IntersectionObserver ??= ObserverStub;
if (typeof w.matchMedia !== 'function') {
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  w.matchMedia = matchMedia;
  if (g.matchMedia === undefined) install('matchMedia', matchMedia);
}
if (typeof g.scrollTo !== 'function') install('scrollTo', () => {});

/** Remove every global this module installed, newest first. */
export function uninstallDom(): void {
  for (let i = installed.length - 1; i >= 0; i--) {
    const { key, previous, had } = installed[i];
    if (had) g[key] = previous;
    else delete g[key];
  }
  installed.length = 0;
}
