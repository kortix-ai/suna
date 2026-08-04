import { describe, expect, test } from 'bun:test';
import {
  captureTurnScrollAnchor,
  restoreTurnScrollAnchor,
} from './session-history-scroll';

function rect(top: number, bottom = top + 100): DOMRect {
  return { top, bottom } as DOMRect;
}

/** A stand-in for a rendered turn. Real turn elements always carry
 *  `data-turn-id`, and the anchor now reads it so a windowed transcript can
 *  re-find the turn after its DOM node has been unmounted by a prepend. */
function turnEl(top: () => number, id: string | null = 'u1', isConnected = true) {
  return {
    isConnected,
    getBoundingClientRect: () => rect(top()),
    getAttribute: (name: string) => (name === 'data-turn-id' ? id : null),
  } as unknown as HTMLElement;
}

describe('session history scroll restoration', () => {
  test('does not move when older messages grow inside the anchored turn', () => {
    let turnTop = 120;
    const turn = turnEl(() => turnTop);
    const container = {
      scrollTop: 0,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);
    turnTop = 120;

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(0);
  });

  test('keeps the anchored turn at the same viewport offset when older turns prepend', () => {
    let turnTop = 120;
    const turn = turnEl(() => turnTop);
    const container = {
      scrollTop: 40,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);
    turnTop = 480;

    expect(restoreTurnScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(400);
  });

  // The id is what makes a windowed transcript recoverable: after a prepend
  // the virtualizer may have unmounted the anchored node, and only the id
  // survives to resolve the turn's new index.
  test('captures the anchored turn id alongside the element', () => {
    const turn = turnEl(() => 120, 'turn-42');
    const container = {
      scrollTop: 0,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    expect(captureTurnScrollAnchor(container)?.turnId).toBe('turn-42');
  });

  test('reports failure when the anchored node was unmounted, so the caller can fall back', () => {
    const turn = turnEl(() => 120, 'turn-42');
    const container = {
      scrollTop: 0,
      contains: (node: Node) => node === turn,
      getBoundingClientRect: () => rect(0, 600),
      querySelectorAll: () => [turn],
    } as unknown as HTMLElement;

    const anchor = captureTurnScrollAnchor(container);

    // A windowed prepend shifts the window and unmounts the node. The restore
    // must report false rather than silently doing nothing, because false is
    // what triggers the id-based recovery path in session-chat.
    const detached = { ...anchor!, element: turnEl(() => 120, 'turn-42', false) };
    expect(restoreTurnScrollAnchor(container, detached)).toBe(false);
  });
});
