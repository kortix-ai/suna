/**
 * How the transcript escapes the app shell when the page is printed.
 *
 * The session shell is a stack of `h-full` flex boxes, every one of them
 * `overflow-hidden` or `overflow-clip` (`session-layout.tsx`), with the
 * transcript's own `overflow-y-auto` scroller at the bottom of it. A browser
 * printing that tree prints ONE viewport: the first page is whatever happened
 * to be scrolled into view, the rest of the conversation is clipped away, and
 * the composer and sidebar come along for the ride. That is exactly what
 * Cmd+P produced before this file existed.
 *
 * Un-clipping the chain by hand does not work either. There is no fixed list of
 * ancestors to target — the shell composes differently for mobile, for the
 * panel-open layout, and for the modal layout — so a selector written today is
 * wrong the next time the shell is refactored.
 *
 * So the chain is discovered at print time instead of being declared. Walk from
 * the transcript up to `<body>`, stamp every ancestor, and let one CSS rule
 * (`print.css`) give them `display: contents` — which removes the box
 * altogether: no height, no overflow, no clipping, children promoted into the
 * page flow. A second rule hides every child of a stamped ancestor that is NOT
 * itself on the chain, which is what takes the sidebar, the header, the action
 * panel and the composer out of the printed page without naming any of them.
 *
 * Nothing here is print-only in principle — it is plain DOM marking — so it is
 * pure and testable, and the hook owns when to apply and remove it.
 */

/** Stamped on every ancestor between the transcript and `<body>`. */
export const PRINT_PASSTHROUGH_ATTR = 'data-print-passthrough';

/** Stamped on the transcript scroller itself — the one child that survives. */
export const PRINT_ROOT_ATTR = 'data-print-root';

/**
 * Opt a node that is NOT on the chain into the printed page anyway.
 *
 * The document header (`session-print-header.tsx`) is the only user today: it
 * is a sibling of the transcript, so the sibling-hiding rule would otherwise
 * remove the very block that names the conversation.
 */
export const PRINT_KEEP_ATTR = 'data-print-keep';

/**
 * The slice of `HTMLElement` this module uses.
 *
 * Structural, not `HTMLElement`, for one reason: `apps/web` registers no
 * jsdom/happy-dom for `bun test` (see `composer-editor.test.ts`), so a function
 * that names `HTMLElement` is a function with no unit tests. A real element
 * satisfies this shape, and a plain object in a test satisfies it too.
 */
export interface PrintChainNode {
  readonly parentElement: PrintChainNode | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Mark `root` and every ancestor of it up to (but excluding) `stopAt`.
 *
 * Returns the elements it stamped, in the order it stamped them, so the caller
 * can hand the same list back to {@link clearPrintChain}. Returning the list
 * rather than re-querying is deliberate: a re-render between print and cleanup
 * can replace nodes, and a query would then miss a stamp and leave the app
 * rendering as `display: contents` on screen.
 */
export function markPrintChain<T extends PrintChainNode>(
  root: T | null | undefined,
  stopAt: PrintChainNode | null = null,
): T[] {
  if (!root) return [];
  const marked: T[] = [];
  root.setAttribute(PRINT_ROOT_ATTR, '');
  marked.push(root);
  // `stopAt` is excluded: `<body>` is not a box we want dissolved, and
  // `print.css` styles it directly instead.
  for (let node = root.parentElement; node && node !== stopAt; node = node.parentElement) {
    node.setAttribute(PRINT_PASSTHROUGH_ATTR, '');
    marked.push(node as T);
  }
  return marked;
}

/** Undo {@link markPrintChain}. Safe to call with a stale list. */
export function clearPrintChain(marked: readonly PrintChainNode[]): void {
  for (const node of marked) {
    node.removeAttribute(PRINT_PASSTHROUGH_ATTR);
    node.removeAttribute(PRINT_ROOT_ATTR);
  }
}
