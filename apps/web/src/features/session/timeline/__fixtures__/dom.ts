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
 * MORE THAN ONE DOM TEST FILE. The module body runs once per process, so a
 * second file that imports it after the first file's `afterAll` would find no
 * `document`. Each DOM test file therefore also calls `installDom()` from
 * `beforeAll`: it (re)installs a fresh window when none is active and counts
 * the holder; `uninstallDom()` releases at zero. The import-time install
 * stays, so a module that decides on `typeof document` at load time
 * (`@tanstack/react-virtual`'s layout-effect choice) sees one.
 *
 * NOT an `act` environment on purpose. `TurnFrame` runs 1s tickers for the
 * working turn; React's async `act` keeps draining its queue while those
 * intervals enqueue work, so `await act(...)` over a working turn never
 * resolves. The render-counter test renders through a plain root and waits
 * a few macrotasks instead.
 */
import { Window } from 'happy-dom';

const g = globalThis as unknown as Record<string, unknown>;

/** Every global this module wrote, with what was there before (`undefined`
 *  for "absent"), so `uninstallDom` restores the exact prior state. */
const installed: { key: string; previous: unknown; had: boolean }[] = [];
let active = false;
let holders = 0;

function install(key: string, value: unknown): void {
  installed.push({ key, previous: g[key], had: key in g });
  g[key] = value;
}

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}

function installGlobals(): void {
  const window = new Window({ url: 'http://localhost/' });
  const w = window as unknown as Record<string, unknown>;

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
  active = true;
}

/** Hold the DOM for this test file (`beforeAll`). Installs a fresh window
 *  when none is active. */
export function installDom(): void {
  if (!active) installGlobals();
  holders++;
}

/** Release the DOM (`afterAll`). The last holder removes every global this
 *  module installed, newest first, restoring the exact prior state. */
export function uninstallDom(): void {
  holders = Math.max(0, holders - 1);
  if (holders > 0 || !active) return;
  for (let i = installed.length - 1; i >= 0; i--) {
    const { key, previous, had } = installed[i];
    if (had) g[key] = previous;
    else delete g[key];
  }
  installed.length = 0;
  active = false;
}

// Import-time install (no holder): a DOM exists while the importing file's
// own imports evaluate; the file's `beforeAll(installDom)` takes the hold.
installGlobals();
