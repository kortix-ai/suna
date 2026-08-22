import './__fixtures__/clock';
import { installDom, networkAttempts, uninstallDom } from './__fixtures__/dom';
import { flush } from './__fixtures__/flush';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@/components/ui/tooltip';
import { TURN_TOP_OFFSET } from '@/hooks/use-auto-scroll';
import type { MessageWithParts, Part, Turn } from '@/ui';
import { groupMessagesIntoTurns } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';

import type { TimelineRow } from '@kortix/sdk';
import { stabilizeTurns } from '../turn/stable-turns';
import { buildChatRows } from './build-chat-rows';
import { deriveAnsweredQuestionIds } from './project-rows';
import { SessionTimelineList, type SessionTimelineListProps } from './session-timeline-list';
import {
  RENDER_OVERSCAN_COLD,
  RENDER_OVERSCAN_WARM,
  TURN_FALLBACK_SIZE,
  type TimelineVirtualApi,
  type TimelineVirtualSeam,
} from './timeline-virtual';

/**
 * The VIRTUAL path of `SessionTimelineList` under happy-dom.
 *
 * happy-dom lays nothing out: every rect is 0×0, ResizeObserver never fires,
 * `scrollTo` writes `scrollTop` without clamping and without a scroll event.
 * The `virtualizerTestSeam` therefore injects the viewport (800×900), a
 * per-turn measure of TURN_FALLBACK_SIZE (so every item IS its estimate) and a
 * `scrollToFn` that clamps like a browser and reports the offset through a
 * scroll event on the next macrotask. What this pins is the WINDOWING and the
 * host API — which turns are in the DOM for a given offset, where a jump
 * lands, how a prepend is anchored — not pixel layout.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type AnyPart = Record<string, unknown>;
const part = (messageID: string, id: string, rest: AnyPart): Part =>
  ({ id, messageID, sessionID: 'ses', ...rest }) as unknown as Part;
const text = (m: string, id: string, body: string) => part(m, id, { type: 'text', text: body });

/** `count` settled turns `t<i>` (user + completed assistant), ids ascending. */
function turns(count: number, prefix = 't', epoch = 1000): MessageWithParts[] {
  const out: MessageWithParts[] = [];
  for (let i = 0; i < count; i++) {
    const u = `${prefix}${i}`;
    const a = `${prefix}${i}a`;
    out.push(
      {
        info: { id: u, role: 'user', sessionID: 'ses', time: { created: epoch + i * 10 } },
        parts: [text(u, `${u}t`, `prompt ${i}`)],
      } as unknown as MessageWithParts,
      {
        info: {
          id: a,
          role: 'assistant',
          parentID: u,
          sessionID: 'ses',
          time: { created: epoch + i * 10 + 1, completed: epoch + i * 10 + 5 },
        },
        parts: [text(a, `${a}t`, `answer ${i}`)],
      } as unknown as MessageWithParts,
    );
  }
  return out;
}

const VIEWPORT = { width: 800, height: 900 };
const SIZE = TURN_FALLBACK_SIZE;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const noop = () => {};
const noopReply = async () => {};
const client = new QueryClient();
const INTL_MESSAGES = {};
const onIntlError = () => {};

const STABLE = {
  pendingTurnIds: new Set<string>(),
  interruptedTurnIds: new Set<string>(),
  inboxRowsByMessageId: new Map(),
  permissions: [],
  questions: [],
  agentNames: [],
  commands: [],
};

class Harness {
  root: Root;
  container: HTMLElement;
  scrollEl: HTMLDivElement;
  apiRef: { current: TimelineVirtualApi | null } = { current: null };
  /** Every offset the virtualizer asked the scroll element to go to. */
  scrolledTo: number[] = [];
  renders: string[] = [];
  rows: TimelineRow[] | undefined;
  turns: Turn[] = [];
  turnRenderKeys = new Map<string, string>();
  seam: TimelineVirtualSeam;
  onRowRender = (key: string): void => {
    this.renders.push(key);
  };

  constructor() {
    this.container = document.createElement('div');
    document.body.appendChild(this.container);
    this.scrollEl = document.createElement('div');
    this.container.appendChild(this.scrollEl);
    // The scroll range a browser would report: the virtual box's height (the
    // only content here) over the injected viewport. `scrollToIndex` clamps
    // its target to `scrollHeight − clientHeight`.
    Object.defineProperty(this.scrollEl, 'scrollHeight', {
      get: () => {
        const box = this.scrollEl.querySelector<HTMLElement>('[data-timeline-virtual]');
        return box ? Number.parseFloat(box.style.height) || 0 : 0;
      },
    });
    Object.defineProperty(this.scrollEl, 'clientHeight', { get: () => VIEWPORT.height });
    this.root = createRoot(this.scrollEl);
    this.seam = {
      initialRect: VIEWPORT,
      observeElementRect: (_instance, cb) => {
        cb(VIEWPORT);
      },
      measureElement: () => SIZE,
      scrollToFn: (offset, _options, instance) => {
        const total = (instance as { getTotalSize(): number }).getTotalSize();
        const clamped = Math.max(0, Math.min(offset, Math.max(0, total - VIEWPORT.height)));
        this.scrolledTo.push(clamped);
        this.scrollEl.scrollTop = clamped;
        setTimeout(() => this.scrollEl.dispatchEvent(this.scrollEvent()), 0);
      },
    };
  }

  /** happy-dom's own `Event` — its `dispatchEvent` rejects Bun's global one. */
  scrollEvent(): Event {
    const view = this.scrollEl.ownerDocument.defaultView as unknown as { Event: typeof Event };
    return new view.Event('scroll');
  }

  /** The reader scrolls: set the offset and let the virtualizer hear it. */
  async scrollTo(offset: number): Promise<void> {
    this.scrollEl.scrollTop = offset;
    this.scrollEl.dispatchEvent(this.scrollEvent());
    await flush();
  }

  props(
    messages: MessageWithParts[],
    working: boolean,
    overrides: Partial<SessionTimelineListProps> = {},
  ): SessionTimelineListProps {
    this.turns = stabilizeTurns(groupMessagesIntoTurns(messages), this.turns);
    const turnsById = new Map<string, Turn>(this.turns.map((t) => [t.userMessage.info.id, t]));
    for (const t of this.turns) {
      const id = t.userMessage.info.id;
      if (!this.turnRenderKeys.has(id)) this.turnRenderKeys.set(id, id);
    }
    const lastId = this.turns.at(-1)?.userMessage.info.id ?? null;
    const workingTurnId = working ? lastId : null;
    this.rows = buildChatRows({
      messages,
      activeUserMessageID: workingTurnId,
      status: working ? 'busy' : 'idle',
      standaloneCallIds: new Set(),
      answeredQuestionIds: deriveAnsweredQuestionIds(this.turns, [], 'ses'),
      prev: this.rows,
    });
    return {
      rows: this.rows,
      turnsById,
      turnRenderKeys: this.turnRenderKeys,
      pendingTurnIds: STABLE.pendingTurnIds,
      interruptedTurnIds: STABLE.interruptedTurnIds,
      sessionWorking: working,
      workingTurnId,
      planAnchorId: null,
      inboxRowsByMessageId: STABLE.inboxRowsByMessageId,
      queueHeld: false,
      onQueueRemove: noop,
      onQueueSendNow: noop,
      onQueueRetry: noop,
      sessionId: 'ses',
      sessionStatus: undefined,
      permissions: STABLE.permissions,
      questions: STABLE.questions,
      agentNames: STABLE.agentNames,
      providers: undefined,
      commandMessages: undefined,
      commands: STABLE.commands,
      disableToolNavigation: false,
      onPermissionReply: noopReply,
      onRewind: noop,
      rewindDisabled: true,
      onRowRender: this.onRowRender,
      scrollElement: this.scrollEl,
      apiRef: this.apiRef,
      virtualizerTestSeam: this.seam,
      ...overrides,
    };
  }

  async render(
    messages: MessageWithParts[],
    working: boolean,
    overrides: Partial<SessionTimelineListProps> = {},
  ): Promise<string[]> {
    const props = this.props(messages, working, overrides);
    this.renders = [];
    this.root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={INTL_MESSAGES} onError={onIntlError}>
          <TooltipProvider>
            <SessionTimelineList {...props} />
          </TooltipProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await flush();
    return [...this.renders];
  }

  mountedIds(): string[] {
    return Array.from(this.scrollEl.querySelectorAll<HTMLElement>('[data-turn-id]')).map((el) =>
      el.getAttribute('data-turn-id')!,
    );
  }

  async unmount(): Promise<void> {
    this.root.unmount();
    await flush();
    this.container.remove();
  }
}

let harness: Harness;
beforeEach(() => {
  harness = new Harness();
});
afterEach(async () => {
  await harness.unmount();
  expect(networkAttempts()).toEqual([]);
});
beforeAll(() => installDom());
afterAll(() => uninstallDom());

const byPrefix = (keys: string[], prefix: string) => keys.filter((k) => k.startsWith(prefix));

/** The turns virtual-core renders for `offset` with every item SIZE tall and
 *  the last turn pinned: the visible range ± `overscan`, clamped. */
function expectedWindow(count: number, offset: number, overscan: number): string[] {
  const start = Math.min(count - 1, Math.floor(offset / SIZE));
  let end = start;
  while (end < count - 1 && (end + 1) * SIZE < offset + VIEWPORT.height) end++;
  const ids = new Set<number>();
  for (let i = Math.max(0, start - overscan); i <= Math.min(count - 1, end + overscan); i++) {
    ids.add(i);
  }
  ids.add(count - 1);
  return [...ids].sort((a, b) => a - b).map((i) => `t${i}`);
}

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

describe('virtual window', () => {
  test('no scroll element → the flat list: every turn, no virtual box', async () => {
    await harness.render(turns(40), false, { scrollElement: null });
    expect(harness.mountedIds()).toHaveLength(40);
    expect(harness.scrollEl.querySelector('[data-timeline-virtual]')).toBeNull();
  });

  test('virtualize={false} → the flat list even with a scroll element', async () => {
    await harness.render(turns(40), false, { virtualize: false });
    expect(harness.mountedIds()).toHaveLength(40);
    expect(harness.scrollEl.querySelector('[data-timeline-virtual]')).toBeNull();
  });

  test('opens at the END: the last turns + overscan are in the DOM, the rest are not', async () => {
    await harness.render(turns(40), false);
    // The box is sized to the whole transcript; the first scroll the
    // virtualizer asked for is the (clamped) end.
    const box = harness.scrollEl.querySelector<HTMLElement>('[data-timeline-virtual]');
    expect(box?.style.height).toBe(`${40 * SIZE}px`);
    expect(harness.scrolledTo[0]).toBe(40 * SIZE - VIEWPORT.height);
    // Two frames in, the warm overscan applies.
    await flush();
    await flush();
    const mounted = harness.mountedIds();
    expect(mounted).toEqual(expectedWindow(40, 40 * SIZE - VIEWPORT.height, RENDER_OVERSCAN_WARM));
    expect(mounted.length).toBeLessThan(40);
    expect(mounted).toContain('t39');
    expect(mounted).not.toContain('t0');
    // Every mounted turn sits in its own positioned slot, keyed by the turn.
    for (const id of mounted) {
      const slot = harness.scrollEl.querySelector<HTMLElement>(`[data-timeline-key="${id}"]`);
      expect(slot?.style.position).toBe('absolute');
      expect(slot?.querySelector(`[data-turn-id="${id}"]`)).not.toBeNull();
    }
  });

  test('opens at the TOP when initialAtEnd is false', async () => {
    await harness.render(turns(40), false, { initialAtEnd: false });
    expect(harness.scrolledTo[0]).toBe(0);
    await flush();
    const mounted = harness.mountedIds();
    expect(mounted[0]).toBe('t0');
    expect(mounted).not.toContain('t30');
    // The last turn is pinned: use-auto-scroll sizes the room from it.
    expect(mounted).toContain('t39');
  });

  test('scrolling the reader up moves the window; the pinned tail stays', async () => {
    await harness.render(turns(40), true);
    await flush();
    await harness.scrollTo(10 * SIZE);
    const mounted = harness.mountedIds();
    expect(mounted).toEqual(expectedWindow(40, 10 * SIZE, RENDER_OVERSCAN_WARM));
    expect(mounted).toContain('t39'); // working turn, pinned
    expect(mounted).not.toContain('t30');
  });

  test('the gap sits BELOW each item as padding, none on the last (pb-12 / pb-3 / none)', async () => {
    await harness.render(turns(40), false);
    await flush();
    const measured = (id: string) =>
      harness.scrollEl.querySelector<HTMLElement>(`[data-timeline-key="${id}"] > [data-index]`);
    expect(measured('t38')?.className).toBe('pb-12');
    expect(measured('t39')?.className).toBe('');
    // The turn element itself carries no top margin in virtual mode.
    expect(
      harness.scrollEl.querySelector<HTMLElement>('[data-turn-id="t39"]')?.className,
    ).not.toContain('mt-');
  });
});

// ---------------------------------------------------------------------------
// the host API
// ---------------------------------------------------------------------------

describe('TimelineVirtualApi', () => {
  test('turnIndex / turnStart / turnAtOffset / isMounted read the virtual geometry', async () => {
    await harness.render(turns(40), false);
    await flush();
    const api = harness.apiRef.current!;
    expect(api).not.toBeNull();
    expect(api.turnIndex('t10')).toBe(10);
    expect(api.turnIndex('nope')).toBeUndefined();
    expect(api.turnStart('t10')).toBe(10 * SIZE);
    expect(api.turnStart('nope')).toBeUndefined();
    expect(api.turnAtOffset(10 * SIZE + 5)).toBe('t10');
    expect(api.turnAtOffset(0)).toBe('t0');
    expect(api.turnAtOffset(10 ** 9)).toBe('t39');
    expect(api.isMounted('t39')).toBe(true);
    expect(api.isMounted('t0')).toBe(false);
  });

  test('scrollToTurn scrolls the turn to TURN_TOP_OFFSET under the viewport top (the legacy −24)', async () => {
    await harness.render(turns(40), false);
    await flush();
    const api = harness.apiRef.current!;
    harness.scrolledTo = [];
    expect(api.scrollToTurn('t10')).toBe(true);
    expect(harness.scrolledTo[0]).toBe(10 * SIZE - TURN_TOP_OFFSET);
    await flush();
    expect(harness.mountedIds()).toContain('t10');
    expect(api.scrollToTurn('nope')).toBe(false);
  });

  test('the api is gone once the list unmounts', async () => {
    await harness.render(turns(4), false);
    expect(harness.apiRef.current).not.toBeNull();
    await harness.unmount();
    expect(harness.apiRef.current).toBeNull();
    // afterEach unmounts again; make that a no-op.
    harness = new Harness();
  });
});

// ---------------------------------------------------------------------------
// history prepend, append, deltas
// ---------------------------------------------------------------------------

describe('prepend / append', () => {
  test('a history prepend keeps the turn at the viewport top where it was (anchored, same commit)', async () => {
    await harness.render(turns(40), false);
    await flush();
    await harness.scrollTo(20 * SIZE);
    expect(harness.mountedIds()).toContain('t20');
    harness.scrolledTo = [];
    // 10 older turns arrive above.
    await harness.render([...turns(10, 'p', 10), ...turns(40)], false);
    // The virtualizer re-anchored the viewport on t20: its start grew by the
    // prepended height and the scroll was moved by the same amount.
    expect(harness.apiRef.current!.turnStart('t20')).toBe(30 * SIZE);
    expect(harness.scrolledTo).toContain(30 * SIZE);
    expect(harness.mountedIds()).toContain('t20');
  });

  test('a new turn appended at the end while at the end is mounted (pinned + in range)', async () => {
    await harness.render(turns(40), true);
    await flush();
    await harness.render(turns(41), true);
    expect(harness.mountedIds()).toContain('t40');
    expect(harness.apiRef.current!.turnIndex('t40')).toBe(40);
  });

  test('a delta on the working turn re-renders one row, nothing under the other mounted turns', async () => {
    const messages = turns(40);
    await harness.render(messages, true);
    await flush();
    const last = messages[messages.length - 1];
    const grown = [
      ...messages.slice(0, -1),
      {
        info: last.info,
        parts: [text(last.info.id, `${last.info.id}t`, 'answer 39 — and more')],
      } as unknown as MessageWithParts,
    ];
    const rendered = await harness.render(grown, true);
    const parts = byPrefix(rendered, 'part:');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('t39a');
    expect(byPrefix(rendered, 'user:')).toEqual([]);
    expect(byPrefix(rendered, 'tail:').filter((k) => k !== 'tail:t39')).toEqual([]);
    expect(byPrefix(rendered, 'frame:')).toEqual(['frame:t39']);
  });

  test('an appended part runs exactly ONE TurnFrame body (the working turn); the other mounted frames hold', async () => {
    const messages = turns(40);
    await harness.render(messages, true);
    await flush();
    expect(harness.mountedIds().length).toBeGreaterThan(1);
    const last = messages[messages.length - 1];
    const appended = [
      ...messages.slice(0, -1),
      {
        info: last.info,
        parts: [...last.parts, text(last.info.id, `${last.info.id}t2`, 'second paragraph')],
      } as unknown as MessageWithParts,
    ];
    const rendered = await harness.render(appended, true);
    // One new row object (the appended part) → one new group object (t39) →
    // one TurnFrame body. Every other mounted turn keeps its group + turn.
    expect(byPrefix(rendered, 'frame:')).toEqual(['frame:t39']);
    expect(byPrefix(rendered, 'part:')).toHaveLength(1);
  });
});

describe('overscan', () => {
  test('the first paint renders fewer turns than the warm window, which applies two frames in', async () => {
    // happy-dom's rAF is a ~16ms timer, so the cold window itself cannot be
    // observed after `flush()`; the constants pin its relation and the warm
    // window is asserted.
    expect(RENDER_OVERSCAN_COLD).toBeLessThan(RENDER_OVERSCAN_WARM);
    await harness.render(turns(40), false);
    await flush();
    await flush();
    const end = 40 * SIZE - VIEWPORT.height;
    expect(harness.mountedIds()).toEqual(expectedWindow(40, end, RENDER_OVERSCAN_WARM));
  });
});
