export interface TurnScrollAnchor {
  element: HTMLElement;
  viewportTop: number;
  /**
   * The anchored turn's id.
   *
   * `element` is only usable while that node stays mounted. A windowed
   * transcript unmounts it as soon as the prepend shifts the window, and then
   * `restoreTurnScrollAnchor` can do nothing. The id survives the prepend, so
   * the caller can resolve the turn's NEW index and scroll to that instead.
   */
  turnId: string | null;
}

export function captureTurnScrollAnchor(container: HTMLElement): TurnScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const turns = container.querySelectorAll<HTMLElement>('[data-turn-id]');
  const element =
    Array.from(turns).find((turn) => turn.getBoundingClientRect().bottom >= containerTop) ??
    turns.item(turns.length - 1);
  if (!element) return null;
  return {
    element,
    viewportTop: element.getBoundingClientRect().top,
    turnId: element.getAttribute('data-turn-id'),
  };
}

export function restoreTurnScrollAnchor(
  container: HTMLElement,
  anchor: TurnScrollAnchor | null,
): boolean {
  if (!anchor?.element.isConnected || !container.contains(anchor.element)) return false;
  container.scrollTop += anchor.element.getBoundingClientRect().top - anchor.viewportTop;
  return true;
}
