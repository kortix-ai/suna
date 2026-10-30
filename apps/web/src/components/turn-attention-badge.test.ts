import { afterEach, describe, expect, test } from 'bun:test';

import { drawBadgeDot, markViewedSeen } from '@/components/turn-attention-badge';
import { useTurnAttentionStore } from '@kortix/ui/internal/stores/turn-attention-store';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function screen(pathname: string, { hidden, focused }: { hidden: boolean; focused: boolean }) {
  Object.defineProperty(globalThis, 'document', {
    value: { hidden, hasFocus: () => focused },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { pathname } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
  useTurnAttentionStore.setState({ unseen: [] });
});

/**
 * KRTX-2520: the session on screen when the person left still counts as
 * unseen. The desktop app is one window: a turn that finishes while it is
 * behind another app finishes on the session it shows, and clearing it right
 * away left the Dock badge at 0.
 */
describe('markViewedSeen', () => {
  test('a session on screen in a window the person left stays unseen', () => {
    useTurnAttentionStore.setState({ unseen: ['s-1'] });
    screen('/projects/p/sessions/s-1', { hidden: true, focused: false });
    markViewedSeen();
    expect(useTurnAttentionStore.getState().unseen).toEqual(['s-1']);
  });

  test('a visible window behind another app does not count as seen either', () => {
    useTurnAttentionStore.setState({ unseen: ['s-1'] });
    screen('/projects/p/sessions/s-1', { hidden: false, focused: false });
    markViewedSeen();
    expect(useTurnAttentionStore.getState().unseen).toEqual(['s-1']);
  });

  test('back in the window, the session on screen is seen and only that one', () => {
    useTurnAttentionStore.setState({ unseen: ['s-1', 's-2'] });
    screen('/projects/p/sessions/s-1', { hidden: false, focused: true });
    markViewedSeen();
    expect(useTurnAttentionStore.getState().unseen).toEqual(['s-2']);
  });
});

/**
 * The favicon tile is full-bleed. A dot inset from the corner reads as
 * misplaced in the tab strip, so it sits flush with the right and bottom
 * edges, and a transparent ring separates it from the logo.
 */
describe('drawBadgeDot', () => {
  function recordingContext() {
    const calls: Array<{ op: string; args?: number[]; composite?: string }> = [];
    const ctx = {
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      beginPath: () => calls.push({ op: 'beginPath' }),
      arc: (...args: number[]) => calls.push({ op: 'arc', args: args.slice(0, 3) }),
      fill() {
        calls.push({ op: 'fill', composite: this.globalCompositeOperation });
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  }

  test('the dot is tangent to the right and bottom edges of the icon', () => {
    const { ctx, calls } = recordingContext();
    drawBadgeDot(ctx, 64, '#0f0');
    const dot = calls.filter((c) => c.op === 'arc').at(-1)!.args!;
    const [cx, cy, r] = dot;
    expect(cx + r).toBe(64);
    expect(cy + r).toBe(64);
    expect(cx).toBe(cy);
  });

  test('a transparent ring is cut out of the logo before the dot is filled', () => {
    const { ctx, calls } = recordingContext();
    drawBadgeDot(ctx, 64, '#0f0');
    const fills = calls.filter((c) => c.op === 'fill');
    expect(fills.map((f) => f.composite)).toEqual(['destination-out', 'source-over']);
    const [cut, dot] = calls.filter((c) => c.op === 'arc').map((c) => c.args!);
    expect(cut[0]).toBe(dot[0]);
    expect(cut[1]).toBe(dot[1]);
    expect(cut[2]).toBeGreaterThan(dot[2]);
    expect((ctx as unknown as { fillStyle: string }).fillStyle).toBe('#0f0');
  });
});
