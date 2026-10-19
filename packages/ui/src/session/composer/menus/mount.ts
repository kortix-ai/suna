import type { SuggestionProps } from '@tiptap/suggestion';

/**
 * Distance in px between the caret and the top of the menu. Matches the
 * suggestion plugin's own default `offset.mainAxis` (4), so the optimistic
 * first-paint position below lands where Floating UI will put it a frame
 * later — no visible jump between the two.
 */
const CARET_GAP = 4;

/**
 * Stacking step for the menu.
 *
 * The plugin appends the popup to `document.body` and sets NO z-index, so paint
 * order is decided purely by document order against everything else the app
 * portals into `body` (Radix popovers, dropdowns, toasts). `60` puts the menu
 * above the app's own overlay layers — it is opened by an explicit keystroke
 * inside a focused editor, so nothing it can cover is more current than it.
 */
const MENU_Z_INDEX = '60';

/**
 * Mounts a suggestion menu's DOM node and returns the plugin's own unmount.
 *
 * ## Why this exists rather than a bare `props.mount(element)`
 *
 * Passing `options.onPosition` changes which side owns positioning, and that
 * matters for one specific reason. Without it, `createMount`
 * (`@tiptap/suggestion@3.27.1`) does this:
 *
 * ```js
 * if (!options.onPosition) {
 *   element.style.visibility = 'hidden';       // hidden the moment it mounts
 *   element.style.width = 'max-content';
 * }
 * // …later, inside computePosition(...).then(...):
 * if (!positioned) { positioned = true; element.style.visibility = ''; }
 * ```
 *
 * The menu is therefore mounted INVISIBLE and only revealed from inside a
 * promise callback. Every path that stops that promise from settling — or
 * stops `autoUpdate` from ever calling `update()` — leaves the popup in the
 * DOM, fully rendered, with its rows and `role="listbox"` intact, and
 * permanently `visibility: hidden`. It fails silently: no console error, no
 * missing element, nothing a DOM query would catch. "The menu does not open"
 * and "the menu opened and cannot be seen" are indistinguishable from the
 * outside, which is exactly the failure that is hard to diagnose from a
 * screenshot.
 *
 * With `onPosition` supplied, the plugin skips that block entirely: it never
 * sets `visibility`, so there is no hidden state to get stuck in, and we take
 * responsibility for `position`/`left`/`top` instead. The element is placed
 * optimistically from `props.clientRect()` before the first async result
 * arrives, so it is correctly positioned on its first paint and Floating UI's
 * result (which adds flipping when there is no room below) only refines it.
 *
 * It also lets the z-index be set on the element the plugin actually appends
 * to `body`, rather than on a React-rendered child inside it — a child cannot
 * raise its parent above a sibling stacking context.
 */
export function mountSuggestionMenu(
  props: Pick<SuggestionProps<never, unknown>, 'mount' | 'clientRect'>,
  element: HTMLElement,
): () => void {
  element.style.position = 'absolute';
  element.style.zIndex = MENU_Z_INDEX;
  element.style.width = 'max-content';

  // Optimistic first placement. `clientRect` is the caret rect the plugin
  // already computed for this transaction, so this is the same anchor Floating
  // UI is about to measure from — not a guess.
  const rect = props.clientRect?.();
  if (rect) {
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.bottom + CARET_GAP}px`;
  }

  return props.mount(element, {
    onPosition: ({ x, y, strategy }) => {
      element.style.position = strategy;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    },
  });
}

/**
 * Floating UI hands us a position on every scroll/resize frame. A docked menu
 * has no use for any of them — but the callback must still be SUPPLIED, for
 * the reason spelled out at length above: `onPosition`'s mere presence is what
 * makes `@tiptap/suggestion` skip its `visibility: hidden` branch. Omitting it
 * here would mount the docked card invisible.
 *
 * Module scope, not rebuilt per mount: nothing about it varies.
 */
const IGNORE_POSITION = () => {};

/**
 * Mounts a menu IN FLOW, inside a host-provided container, instead of floating
 * it at the caret.
 *
 * ## Why the `/` menu is docked and the `@` menu is not
 *
 * They answer different questions. `@` names a thing at a point in a sentence,
 * so its menu belongs at that point — beside the caret, over the page, gone
 * the moment you pick. `/` chooses what the whole message DOES. It is a mode
 * for the composer, it carries a description pane you actually read, and at
 * ~40rem wide it is a panel, not a tooltip. Floating a panel that large off a
 * caret that sits a few pixels above the viewport bottom means it flips,
 * overlaps the composer it belongs to, and covers the text you are typing to
 * filter it.
 *
 * Docked, it sits above the composer as its own card: the composer keeps its
 * own box and stays entirely about composing, the list never covers the query
 * being typed, and the card's width is the composer's width rather than a
 * number picked to survive a flip.
 *
 * ## Mechanics
 *
 * The plugin's own `container` option (`SuggestionOptions.container`, a
 * selector string or element, default `document.body`) is what actually
 * redirects the `appendChild` — see `editor/suggestion.ts`, which threads it
 * through. Passing it as a SELECTOR matters: the container is resolved at
 * mount time via `document.querySelector`, so the dock element does not need
 * to exist when the extension is constructed (it does not — extensions are
 * frozen at editor construction, the dock is a React sibling that renders
 * later), and a missing dock degrades to `document.body` instead of throwing.
 *
 * This function therefore only has to undo the floating geometry: no
 * `position`/`left`/`top`, no z-index (in flow it needs none), and full width
 * of the dock. The plugin still owns append, outside-click dismissal, and
 * removal on unmount — `createMount` removes the element only when it was the
 * one that appended it, which it was.
 */
export function mountDockedMenu(
  props: Pick<SuggestionProps<never, unknown>, 'mount'>,
  element: HTMLElement,
): () => void {
  element.style.position = 'static';
  element.style.width = '100%';
  return props.mount(element, { onPosition: IGNORE_POSITION });
}
