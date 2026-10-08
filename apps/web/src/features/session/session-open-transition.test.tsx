/**
 * The home composer → session hand-off, through a real React commit.
 *
 * `useSessionOpenSource` must leave a copy of the departing page in the SAME
 * commit that removes it (or one frame shows the gap), keep it over whatever
 * the route paints next, and dissolve it only once the session's own surface
 * is in the DOM. Mounted with `createRoot` against happy-dom, the pattern of
 * `diff-layout-toggle.test.tsx`. happy-dom has no layout, so the pane's
 * rectangle is stubbed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900, url: 'http://localhost:3000/en/projects/p1' });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.MutationObserver = win.MutationObserver;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

const PANE_BOX = { left: 248, top: 0, width: 1192, height: 900, right: 1440, bottom: 900, x: 248, y: 0 };
(win.HTMLElement.prototype as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect =
  function (this: HTMLElement) {
    return this.hasAttribute('data-home-pane') ? PANE_BOX : { ...PANE_BOX, width: 0, height: 0 };
  };

import {
  SESSION_OPEN_GHOST_ATTRIBUTE,
  isSessionPath,
  markSessionOpening,
  sessionSurfaceSelector,
  takeSessionOpening,
  useSessionOpenSource,
  waitForSurface,
} from './session-open-transition';

const SESSION_ID = '9f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const PROMPT = 'Reply with one short sentence about the weather on Mars.';

function HomePane() {
  const ref = useRef<HTMLDivElement>(null);
  useSessionOpenSource(ref);
  return (
    <div ref={ref} data-home-pane="">
      <h1>What&apos;s next?</h1>
      <div contentEditable suppressContentEditableWarning>
        {PROMPT}
      </div>
    </div>
  );
}

function PendingScreen() {
  return <div data-slot="project-pending-screen" />;
}

function SessionSurface() {
  return <div data-session-surface={SESSION_ID}>{PROMPT}</div>;
}

/** Next writes the URL in the navigation's own commit. */
function navigate(path: string, next: React.ReactNode) {
  act(() => {
    win.history.pushState({}, '', path);
    root!.render(next);
  });
}

const SESSION_PATH = `/en/projects/p1/sessions/${SESSION_ID}`;

const ghosts = () => Array.from(document.querySelectorAll(`[${SESSION_OPEN_GHOST_ATTRIBUTE}]`));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  win.history.pushState({}, '', '/en/projects/p1');
  act(() => root?.unmount());
  host?.remove();
  for (const ghost of ghosts()) ghost.remove();
  takeSessionOpening();
  root = null;
  host = null;
});

describe('useSessionOpenSource', () => {
  test('leaves a copy in the commit that removes the page, over the pending screen', async () => {
    mount(<HomePane />);
    markSessionOpening(SESSION_ID);

    // The prefetched route paints the project's pending screen first.
    navigate(SESSION_PATH, <PendingScreen />);
    await Promise.resolve();
    expect(host!.querySelector('[data-home-pane]')).toBeNull();
    expect(host!.querySelector('[data-slot="project-pending-screen"]')).not.toBeNull();
    const [ghost] = ghosts();
    expect(ghost).toBeDefined();
    expect(ghosts()).toHaveLength(1);
    expect(ghost.textContent).toContain(PROMPT);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect((ghost as HTMLElement).style.left).toBe('248px');
    expect((ghost as HTMLElement).style.width).toBe('1192px');

    // No session surface yet: the copy holds.
    await wait(30);
    expect(ghost.hasAttribute('data-leaving')).toBe(false);

    // The session mounts: the copy starts to dissolve, then leaves the DOM.
    act(() => root!.render(<SessionSurface />));
    await wait(30);
    expect(ghost.hasAttribute('data-leaving')).toBe(true);
    await wait(400);
    expect(ghosts()).toHaveLength(0);
  });

  test('dissolves at once when the session mounts in the same commit', async () => {
    mount(<HomePane />);
    markSessionOpening(SESSION_ID);
    navigate(SESSION_PATH, <SessionSurface />);
    expect(ghosts()).toHaveLength(1);
    await wait(30);
    expect(ghosts()[0]?.hasAttribute('data-leaving')).toBe(true);
  });

  test("a child's transition ending does not cut the dissolve short", async () => {
    mount(<HomePane />);
    markSessionOpening(SESSION_ID);
    navigate(SESSION_PATH, <SessionSurface />);
    await wait(30);
    const [ghost] = ghosts();
    expect(ghost.hasAttribute('data-leaving')).toBe(true);
    // `transitionend` bubbles from anything inside the copy.
    const child = ghost.querySelector('h1')!;
    child.dispatchEvent(new win.Event('transitionend', { bubbles: true }) as unknown as Event);
    expect(ghosts()).toHaveLength(1);
    ghost.dispatchEvent(new win.Event('transitionend', { bubbles: true }) as unknown as Event);
    expect(ghosts()).toHaveLength(0);
  });

  test('leaves nothing when the page unmounts for any other reason', () => {
    mount(<HomePane />);
    navigate('/en/projects/p1/customize', <PendingScreen />);
    expect(ghosts()).toHaveLength(0);
  });

  test('drops the copy before it paints when the page left for somewhere else', async () => {
    // Sent, then another click won the race: the home page unmounts for a
    // page that is not the session, with the hand-off still pending.
    mount(<HomePane />);
    markSessionOpening(SESSION_ID);
    navigate('/en/projects/p1/customize', <PendingScreen />);
    // In the commit (no frame has painted yet)…
    expect(ghosts()).toHaveLength(1);
    // …and gone in the microtask after it, before the browser paints.
    await Promise.resolve();
    expect(ghosts()).toHaveLength(0);
  });

  test('waits out a cold route compile', async () => {
    // A cold dev server took 4.35 s to serve the session route, and the home
    // page unmounted 5.3 s after the send.
    mount(<HomePane />);
    markSessionOpening(SESSION_ID, Date.now() - 5_300);
    navigate(SESSION_PATH, <SessionSurface />);
    await Promise.resolve();
    expect(ghosts()).toHaveLength(1);
  });

  test('one hand-off leaves one copy', () => {
    markSessionOpening(SESSION_ID);
    expect(takeSessionOpening()?.sessionId).toBe(SESSION_ID);
    expect(takeSessionOpening()).toBeNull();
  });

  test("the copy carries the wallpaper canvas as it drew in the hand-off's frame", async () => {
    // happy-dom has no canvas backend: record what each 2D context is given.
    const drawn: Array<{ into: HTMLCanvasElement; from: unknown }> = [];
    const proto = win.HTMLCanvasElement.prototype as unknown as {
      getContext: (this: HTMLCanvasElement) => unknown;
    };
    const original = proto.getContext;
    proto.getContext = function (this: HTMLCanvasElement) {
      return { drawImage: (from: unknown) => drawn.push({ into: this, from }) };
    };
    try {
      function ShaderPane() {
        const ref = useRef<HTMLDivElement>(null);
        useSessionOpenSource(ref);
        return (
          <div ref={ref} data-home-pane="">
            <canvas data-wallpaper="" width={1119} height={900} />
          </div>
        );
      }
      mount(<ShaderPane />);
      const wallpaper = host!.querySelector('[data-wallpaper]');
      markSessionOpening(SESSION_ID);
      // The snapshot is taken in the next animation frame, not at unmount.
      expect(drawn).toHaveLength(0);
      await wait(10);
      expect(drawn).toHaveLength(1);
      expect(drawn[0].from).toBe(wallpaper);
      const snapshot = drawn[0].into;
      expect(snapshot.width).toBe(1119);

      navigate(SESSION_PATH, <SessionSurface />);
      const copied = ghosts()[0]?.querySelector('canvas');
      expect(copied).not.toBeNull();
      expect(drawn).toHaveLength(2);
      expect(drawn[1]).toEqual({ into: copied as HTMLCanvasElement, from: snapshot });
    } finally {
      proto.getContext = original;
    }
  });

  test('a hand-off that never navigated expires', () => {
    markSessionOpening(SESSION_ID, 1_000);
    expect(takeSessionOpening(1_000 + 60_001)).toBeNull();
  });
});

describe('waitForSurface', () => {
  test('gives up after the wait, so a route that never lands cannot hold the copy', async () => {
    let watching = false;
    const started = performance.now();
    await waitForSurface(() => false, 20, () => {
      watching = true;
      return () => {
        watching = false;
      };
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(watching).toBe(false);
  });

  test('a session path matches under any locale prefix, and nothing else does', () => {
    expect(isSessionPath(`/projects/p1/sessions/${SESSION_ID}`, SESSION_ID)).toBe(true);
    expect(isSessionPath(`/de/projects/p1/sessions/${SESSION_ID}/`, SESSION_ID)).toBe(true);
    expect(isSessionPath('/en/projects/p1', SESSION_ID)).toBe(false);
    expect(isSessionPath(`/en/projects/p1/sessions/${SESSION_ID}x`, SESSION_ID)).toBe(false);
  });

  test('the selector cannot be broken out of by a malformed id', () => {
    expect(sessionSurfaceSelector('a"]b')).toBe('[data-session-surface="a\\"]b"]');
  });
});
