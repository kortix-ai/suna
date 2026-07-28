import { describe, expect, test } from 'bun:test';
import { captureTurnScrollAnchor, restoreTurnScrollAnchor } from './session-history-scroll';

function rect(top: number, bottom = top + 100): DOMRect {
  return { top, bottom } as DOMRect;
}

describe('session history scroll restoration', () => {
  test('does not move when older messages grow inside the anchored turn', () => {
    let turnTop = 120;
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
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
    const turn = {
      isConnected: true,
      getBoundingClientRect: () => rect(turnTop),
    } as HTMLElement;
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
});
