import { afterAll, describe, expect, test } from 'bun:test';

// ─── Minimal DOM stub ───────────────────────────────────────────────────────
// bun test's runtime has no DOM and this package has no jsdom/happy-dom (same
// constraint, same handling, as `action-navigator-logic.test.ts` and
// `shader-safe.test.ts`: a hand-rolled stub installed for this file only).
// `isFloatingLayerTarget` is a predicate over DOM shape — `instanceof Element`
// plus `closest()` — so the stub only has to be truthful about that shape.
// `hasOpenFloatingLayer` reads `document.querySelector`, so we stub that too.
class StubElement {
  parentElement: StubElement | null = null;
  private readonly attrs = new Map<string, string>();

  constructor(attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }

  appendChild<T extends StubElement>(child: T): T {
    child.parentElement = this;
    return child;
  }

  private matches(selector: string): boolean {
    // Only the attribute form the floating-layer selector uses: [a] / [a="v"].
    const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector.trim());
    if (!m) return false;
    const [, name, value] = m;
    if (!this.attrs.has(name)) return false;
    return value === undefined || this.attrs.get(name) === value;
  }

  matchesSelector(selector: string): boolean {
    return this.matches(selector);
  }

  closest(selectorList: string): StubElement | null {
    return closestFrom(this, selectorList);
  }
}

function closestFrom(start: StubElement, selectorList: string): StubElement | null {
  const selectors = selectorList.split(',');
  let node: StubElement | null = start;
  while (node) {
    const current = node;
    if (selectors.some((s) => current.matchesSelector(s))) return current;
    node = node.parentElement;
  }
  return null;
}

/** Mutable: tests that need an open menu set this before calling the predicate. */
let openFloatingLayer: StubElement | null = null;

const priorElement = (globalThis as { Element?: unknown }).Element;
const priorDocument = (globalThis as { document?: unknown }).document;
(globalThis as { Element?: unknown }).Element = StubElement;
(globalThis as { document?: unknown }).document = {
  querySelector(selector: string) {
    if (openFloatingLayer && String(selector).includes('data-state="open"')) {
      return openFloatingLayer;
    }
    return null;
  },
};
afterAll(() => {
  (globalThis as { Element?: unknown }).Element = priorElement;
  (globalThis as { document?: unknown }).document = priorDocument;
});

/** The stub stands in for a real `Element` at runtime; TS still needs telling. */
const asTarget = (el: StubElement): EventTarget => el as unknown as EventTarget;

const { modalDismissesOnOutsideInteraction, resolveModalElevation } = await import('./modal');

describe('resolveModalElevation', () => {
  test('opaque modal variants elevate by default', () => {
    expect(resolveModalElevation(undefined, 'default', 'bottom')).toBe('default');
    expect(resolveModalElevation(undefined, 'base', 'left')).toBe('default');
  });

  test('transparent and fullscreen variants stay flat by default', () => {
    expect(resolveModalElevation(undefined, 'transparent', 'bottom')).toBe('none');
    expect(resolveModalElevation(undefined, 'base', 'fullscreen')).toBe('none');
  });

  test('an explicit elevation choice wins', () => {
    expect(resolveModalElevation('default', 'transparent', 'fullscreen')).toBe('default');
    expect(resolveModalElevation('none', 'default', 'bottom')).toBe('none');
  });
});

describe('modalDismissesOnOutsideInteraction', () => {
  test('a click on the backdrop dismisses', () => {
    expect(modalDismissesOnOutsideInteraction(asTarget(new StubElement()), true)).toBe(true);
  });

  test('a null target dismisses', () => {
    expect(modalDismissesOnOutsideInteraction(null, true)).toBe(true);
  });

  // The regression this file exists for. A Select/DropdownMenu panel is portaled
  // out of the modal's DOM, so Radix reports a click on it as "outside".
  // Dismissing there closed the entire modal the moment a chevron was clicked —
  // reproduced on the connector modal's Accounts, Tools and Settings tabs alike.
  const floatingPanels: Array<[string, Record<string, string>]> = [
    ['listbox (Select)', { role: 'listbox' }],
    ['menu (DropdownMenu)', { role: 'menu' }],
    ['tooltip', { role: 'tooltip' }],
    ['popper wrapper', { 'data-radix-popper-content-wrapper': '' }],
  ];

  for (const [label, attrs] of floatingPanels) {
    test(`a click on a portaled ${label} does NOT dismiss`, () => {
      expect(modalDismissesOnOutsideInteraction(asTarget(new StubElement(attrs)), true)).toBe(false);
    });

    test(`a click on a descendant of a portaled ${label} does NOT dismiss`, () => {
      // The real case: the user clicks the option, never the panel itself.
      const option = new StubElement(attrs).appendChild(new StubElement());
      expect(modalDismissesOnOutsideInteraction(asTarget(option), true)).toBe(false);
    });
  }

  test('closeOnOutsideClick=false never dismisses', () => {
    expect(modalDismissesOnOutsideInteraction(asTarget(new StubElement()), false)).toBe(false);
    expect(modalDismissesOnOutsideInteraction(null, false)).toBe(false);
  });

  // Modal DropdownMenu / Select set pointer-events:none under themselves. A click
  // that visually lands on the modal body or the dark overlay therefore targets
  // body/overlay — not the menu. Target-only checks miss that case; the open
  // floating layer owns the gesture (same rule Escape already applied).
  test('while a floating layer is open, a non-menu click does NOT dismiss', () => {
    openFloatingLayer = new StubElement({ role: 'menu', 'data-state': 'open' });
    try {
      expect(modalDismissesOnOutsideInteraction(asTarget(new StubElement()), true)).toBe(false);
      expect(modalDismissesOnOutsideInteraction(null, true)).toBe(false);
    } finally {
      openFloatingLayer = null;
    }
  });
});
