export interface TurnScrollAnchor {
  element: HTMLElement;
  viewportTop: number;
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
