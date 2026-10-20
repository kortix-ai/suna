import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { captureTurnScrollAnchor, holdTurnScrollAnchor } from './session-history-scroll';

function rect(top: number, bottom = top + 100): DOMRect {
  return { top, bottom } as DOMRect;
}

/** The ResizeObserver the hold creates: a test delivers each layout pass by hand. */
let observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    observers.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  disconnect() {
    this.disconnected = true;
  }
  deliver() {
    if (!this.disconnected) this.callback();
  }
}
const realResizeObserver = globalThis.ResizeObserver;
beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});
/** One layout pass: the browser runs ResizeObserver callbacks after layout, before paint. */
const layout = () => observers.forEach((observer) => observer.deliver());

/**
 * A transcript with one turn, laid out like a browser would: the turn has a
 * fixed position in the content (`contentTop`), and its viewport top is that
 * minus `scrollTop` (the container's own top is 0).
 */
function transcript(initial: { turnTop: number; scrollTop: number; connected?: boolean }) {
  const connected = initial.connected ?? true;
  const geometry = { contentTop: initial.turnTop + initial.scrollTop };
  const turn = {
    isConnected: connected,
    getBoundingClientRect: () => rect(geometry.contentTop - container.scrollTop),
  } as HTMLElement;
  const container = {
    scrollTop: initial.scrollTop,
    contains: (node: Node) => connected && node === turn,
    getBoundingClientRect: () => rect(0, 600),
    querySelectorAll: () => [turn],
  } as unknown as HTMLElement;
  const content = {} as HTMLElement;
  return {
    container,
    content,
    turn,
    /** Content inserted (+) or removed (−) above the turn moves it in the content. */
    insertAbove: (px: number) => {
      geometry.contentTop += px;
    },
    /** The reader scrolls by `px`. */
    readerScrolls: (px: number) => {
      container.scrollTop += px;
    },
    /** Where the reader sees the turn: its viewport top. */
    seenAt: () => geometry.contentTop - container.scrollTop,
  };
}

describe('older-history anchor hold', () => {
  test('a page that renders AFTER the pull resolved still leaves the reader in place', () => {
    // The live-reply jump: the paced transcript delivers the older page on its
    // trailing edge, a frame or more after `loadOlder()` resolved. Whichever
    // layout pass the page lands in, the hold corrects it before paint.
    const t = transcript({ turnTop: 120, scrollTop: 40 });
    const release = holdTurnScrollAnchor(t.container, t.content, captureTurnScrollAnchor(t.container));
    layout(); // the frame right after the pull resolved: nothing rendered yet
    expect(t.container.scrollTop).toBe(40);

    t.insertAbove(360); // the older page commits in a later frame
    layout();
    expect(t.container.scrollTop).toBe(400);
    expect(t.seenAt()).toBe(120);
    release();
  });

  test('the loading row rising and falling above the turn moves nothing', () => {
    const t = transcript({ turnTop: 120, scrollTop: 40 });
    const release = holdTurnScrollAnchor(t.container, t.content, captureTurnScrollAnchor(t.container));

    t.insertAbove(31); // "Loading older messages" mounts above every turn
    layout();
    expect(t.seenAt()).toBe(120);

    t.insertAbove(500); // the page
    layout();
    expect(t.seenAt()).toBe(120);

    t.insertAbove(-31); // the row comes down in the commit that releases the hold
    release();
    expect(t.container.scrollTop).toBe(540);
    expect(t.seenAt()).toBe(120);
  });

  test("the reader's own scrolling during the hold is left alone", () => {
    const t = transcript({ turnTop: 50, scrollTop: 600 });
    const release = holdTurnScrollAnchor(t.container, t.content, captureTurnScrollAnchor(t.container));

    t.readerScrolls(-500); // the reader keeps scrolling up while the page is in flight
    layout(); // a streamed token below the turn grew the content: no correction
    expect(t.container.scrollTop).toBe(100);

    t.insertAbove(250);
    layout();
    expect(t.container.scrollTop).toBe(350); // 100 of their own + 250 inserted, not 600 + 250
    release();
  });

  test('release stops the hold: a later change is not corrected, and the observer is gone', () => {
    const t = transcript({ turnTop: 120, scrollTop: 40 });
    const release = holdTurnScrollAnchor(t.container, t.content, captureTurnScrollAnchor(t.container));
    expect(observers[0].observed).toEqual([t.content]);

    release();
    release(); // idempotent
    expect(observers[0].disconnected).toBe(true);
    t.insertAbove(200);
    layout();
    expect(t.container.scrollTop).toBe(40);
  });

  test('an anchor that left the DOM is never written', () => {
    const t = transcript({ turnTop: 120, scrollTop: 40, connected: false });
    const release = holdTurnScrollAnchor(t.container, t.content, { element: t.turn, contentTop: 160 });
    t.insertAbove(300);
    layout();
    release();
    expect(t.container.scrollTop).toBe(40);
  });

  test('no anchor (an empty transcript) observes nothing', () => {
    const t = transcript({ turnTop: 120, scrollTop: 40 });
    const release = holdTurnScrollAnchor(t.container, t.content, null);
    expect(observers).toHaveLength(0);
    release();
    expect(t.container.scrollTop).toBe(40);
  });
});
