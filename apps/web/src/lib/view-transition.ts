import { flushSync } from 'react-dom';

interface ViewTransitionOptions {
  x: number;
  y: number;
  duration?: number;
  easing?: string;
}

export function startCircularTransition(
  applyChange: () => void,
  opts: ViewTransitionOptions,
): void {
  const { x, y, duration = 400, easing = 'ease-in-out' } = opts;

  if (typeof document.startViewTransition !== 'function') {
    applyChange();
    return;
  }

  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const maxRadius = Math.hypot(
    Math.max(x, viewportWidth - x),
    Math.max(y, viewportHeight - y),
  );

  const transition = document.startViewTransition(() => {
    flushSync(applyChange);
  });

  transition.ready.then(() => {
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${maxRadius}px at ${x}px ${y}px)`,
        ],
      },
      { duration, easing, pseudoElement: '::view-transition-new(root)' },
    );
  });
}

export function transitionFromElement(
  element: HTMLElement,
  applyChange: () => void,
  duration?: number,
): void {
  const { top, left, width, height } = element.getBoundingClientRect();
  startCircularTransition(applyChange, {
    x: left + width / 2,
    y: top + height / 2,
    duration,
  });
}
