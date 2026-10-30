/**
 * Per-press decision logic for the triple-ESC-to-stop shortcut
 * (`session-chat.tsx`, "Triple-ESC to stop").
 *
 * Extracted pure so the one non-obvious contract is pinned by a unit test: an
 * Escape pressed inside the composer's ProseMirror editor reaches the window
 * bubble listener with `defaultPrevented` already `true`. ProseMirror's
 * backdrop key mapping (`captureKeyDown` in `prosemirror-view`, the
 * `code == 13 || code == 27` branch) suppresses EVERY Escape inside the
 * contenteditable — suggestion menu open or not — so `defaultPrevented`
 * cannot distinguish "the `@`/`/` menu consumed this Escape" from
 * "ProseMirror reflexively suppressed it". A blanket `defaultPrevented` veto
 * therefore made the shortcut silently dead exactly where the user's hands
 * are during a run: the chat input.
 */
export interface EscapePress {
  /** `e.target` sits inside the composer's TipTap editor. */
  fromComposerEditor: boolean;
  /** `e.defaultPrevented` at bubble time. */
  defaultPrevented: boolean;
  /**
   * An `@`/`/` suggestion listbox was in the DOM at CAPTURE time. It must be
   * sampled by a capture-phase listener: `@tiptap/suggestion` handles Escape
   * and unmounts its listbox synchronously inside the editor's own keydown
   * handling, so by bubble time the menu this press dismissed is already gone
   * from the DOM.
   */
  suggestionMenuWasOpen: boolean;
  /**
   * Focus sits inside a dialog / menu / popover / select — that Escape is for
   * dismissing the overlay, never for stopping.
   */
  focusInOverlay: boolean;
  /** `e.isComposing` — the Escape is cancelling an IME composition. */
  isComposing: boolean;
}

export function shouldCountEscape(press: EscapePress): boolean {
  if (press.isComposing) return false;
  if (press.focusInOverlay) return false;
  // Composer-origin presses: ignore `defaultPrevented` (ProseMirror sets it
  // unconditionally); the only real consumer is an open suggestion menu.
  if (press.fromComposerEditor) return !press.suggestionMenuWasOpen;
  return !press.defaultPrevented;
}

/**
 * The composer's contenteditable. Matches the accessibility attributes set in
 * `composer/editor/composer-editor.tsx` (`editorProps.attributes`).
 */
export const COMPOSER_EDITOR_SELECTOR = '[role="textbox"][aria-label="Message input"]';

/**
 * The two suggestion listboxes — `composer/menus/mention-menu.tsx` and
 * `composer/menus/slash-menu.tsx`. Matched by accessible name because the
 * menus portal to `document.body` (mention) or the slash dock with no other
 * stable hook; `composer/composer.tsx`'s `isSuggestionListbox` keys off the
 * same two labels.
 */
export const SUGGESTION_MENU_SELECTOR =
  '[role="listbox"][aria-label="Mention suggestions"],[role="listbox"][aria-label="Commands and actions"]';
