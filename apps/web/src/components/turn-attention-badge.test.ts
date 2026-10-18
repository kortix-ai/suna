import { afterEach, describe, expect, test } from 'bun:test';

import { markViewedSeen } from '@/components/turn-attention-badge';
import { useTurnAttentionStore } from '@/stores/turn-attention-store';

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
