import { clampSelection, moveSelection } from './menu-selection';

export interface MenuNavStateOptions {
  /**
   * Fires ONLY on the false<->true boundary — same discipline as
   * `trackEmptyBoundary` (`editor/composer-editor.tsx`) — so a caller's ref
   * only flips when the answer actually changes.
   *
   * This is what the Enter-to-submit guard in `composer-editor.tsx` reads.
   * It answers "should Enter go to this menu rather than send the message",
   * which is TWO cases, not one:
   *
   *  1. A selectable row exists right now.
   *  2. The menu is open but its rows for the CURRENT query have not been
   *     reported yet.
   *
   * Case 2 is not a nicety. Rows arrive from React — `MentionMenuHost`'s
   * effect, after a debounced `useFileSearch` resolves — while the submit
   * guard is a DIRECT editor prop, which ProseMirror checks before any
   * plugin's `handleKeyDown`. So between "`@` opened / the query changed"
   * and "rows reported for that query", `hasRows` still describes the
   * PREVIOUS query. Reporting that gap as `false` sent the message while the
   * file the user had just picked out of the list was on screen: typing `@`,
   * finding a file, and pressing Enter submitted the draft instead of
   * inserting the mention.
   *
   * A match whose rows ARE known and empty (`@nonexistentfile`, `/xyzzy`)
   * still reports `false` for its whole life, so Enter falls through to
   * submit exactly like the live `session-chat-input.tsx:932`/`:958`/`:990`
   * guards (`mentionItems.length > 0`, `filteredCommands.length > 0`).
   */
  onOwnsEnterChange?: (ownsEnter: boolean) => void;
  /**
   * Fires on the false<->true boundary of "is a trigger match active at
   * all" -- the OPPOSITE half of what `onOwnsEnterChange` answers. `open()`
   * and `close()` are already 1:1 with a real `@tiptap/suggestion`
   * `onStart`/`onExit` pair (the plugin never calls either one twice in a
   * row without the other between), so this needs no extra dedupe of its
   * own -- every `open()` call fires `true` exactly once, every `close()`
   * call fires `false` exactly once.
   *
   * Task 9's seam for cache revalidation: a menu with zero rows (e.g.
   * `@nonexistentfile`) still just OPENED -- the user might still type a
   * query that matches something newly created -- so this must fire on
   * `open()` regardless of what `onOwnsEnterChange` says, which is exactly why
   * it is a second callback and not folded into the first.
   */
  onOpenChange?: (isOpen: boolean) => void;
}

/**
 * The keyboard-navigation state machine both the `@` and `/` menus share —
 * pulled out of `mention-controller.ts` / `slash-controller.ts` so it is
 * directly unit-testable without constructing a `ReactRenderer` (which calls
 * `document.createElement` — unavailable in `bun test`; see
 * `composer-editor.test.ts`'s file header for the same constraint on this
 * codebase's headless suite).
 *
 * Owns exactly the plain-JS state a controller needs across
 * onStart/onUpdate/onKeyDown/onExit: the flat row list, the derived selected
 * index (never React state — Task 6's "derived index" design, one level up:
 * there is no React component for state to live in until the popup mounts,
 * and even mounted it only ever receives `selectedIndex` as a prop), the
 * last-seen query, and whether any row currently exists.
 */
export class MenuNavState<TRow> {
  private rows: TRow[] = [];
  private selectedIndex = 0;
  private lastQuery: string | null = null;
  private hasRows = false;
  /**
   * The query `hasRows` was last computed for, or `null` for "not computed
   * since this menu opened". When it differs from `lastQuery` the row list on
   * hand belongs to an older query, so whether this menu has anything to
   * offer is UNKNOWN — see `onOwnsEnterChange`, case 2.
   */
  private rowsKnownFor: string | null = null;
  /**
   * Fix round 2 — latent re-arm race: `setRows` is the only place `hasRows`
   * can flip back to `true`, and nothing previously stopped it from doing
   * that AFTER `close()`. Reaching it needs a `setRows` call to land in the
   * gap between `close()` running and whatever queued it being torn down —
   * plausible whenever a match-ending transaction (e.g.
   * `dismissOnOutsideClick`, which dispatches exit at an arbitrary time) lands
   * while `MentionMenuHost`'s effect is still pending. Once mis-armed, NOTHING
   * would clear it again until the next `open()` — Enter would silently stop
   * doing anything (no submit, no selection) with no menu even open, the
   * exact original bug one layer removed. `setRows` is a no-op whenever the
   * state isn't open — the only two things that can end that no-op window are
   * `open()` (starts it) and `close()` (ends it).
   */
  private isOpen = false;
  private readonly onOwnsEnterChange?: (ownsEnter: boolean) => void;
  private readonly onOpenChange?: (isOpen: boolean) => void;

  constructor(options: MenuNavStateOptions = {}) {
    this.onOwnsEnterChange = options.onOwnsEnterChange;
    this.onOpenChange = options.onOpenChange;
  }

  /** Call once when a new trigger match starts (the menu just opened). */
  open(query: string): void {
    this.isOpen = true;
    this.onOpenChange?.(true);
    this.rows = [];
    this.selectedIndex = 0;
    this.lastQuery = query;
    // Unknown, not empty: the menu has just opened and nothing has reported
    // rows for `query` yet. `emitOwnsEnter` reads this as "Enter is mine".
    this.rowsKnownFor = null;
    this.hasRows = false;
    this.emitOwnsEnter();
  }

  /**
   * Call whenever the trigger's query text may have changed. Resets the
   * selection to `0` ONLY when the query itself changed — this is the fix
   * for selecting a stale row: without it, arrowing down to row 5 and then
   * typing one more character keeps row 5 highlighted against a completely
   * different list. Matches the live reset-every-keystroke behaviour at
   * `session-chat-input.tsx:1005` (slash) / `:1026` (mention) exactly.
   *
   * Deliberately does NOT touch the index when the query is unchanged — a
   * same-query row-list refresh (a debounced file search resolving, or an
   * agent/session list updating) goes through `setRows` instead, which
   * CLAMPS rather than resets, so results arriving after you've already
   * arrowed down don't yank your selection back to the top.
   */
  setQuery(query: string): void {
    if (query === this.lastQuery) return;
    this.lastQuery = query;
    this.selectedIndex = 0;
    // `hasRows` is deliberately left alone — the rows are still on screen
    // until the new ones arrive. But they describe the OLD query now, so
    // `rowsKnownFor` no longer matches and Enter belongs to the menu until
    // `setRows` says otherwise.
    this.emitOwnsEnter();
  }

  /**
   * Call whenever the row list is recomputed — synchronously on every
   * keystroke for the `/` menu, or asynchronously whenever `useFileSearch`
   * resolves for the `@` menu. Clamps the index (handles the list shrinking
   * under a stationary query) and is the single source of truth for
   * `onOwnsEnterChange` — see that option's own doc comment for why this must
   * be driven from here, not from `open`/`close`.
   *
   * A no-op while closed (fix round 2, Open 2) — a stray call arriving after
   * `close()` (a plausible race: `MentionMenuHost`'s effect still pending
   * when an exit transaction lands) must not silently re-arm `hasRows` with
   * no menu open. See `isOpen`'s own field comment.
   */
  setRows(rows: TRow[]): void {
    if (!this.isOpen) return;
    this.rows = rows;
    this.selectedIndex = clampSelection(this.selectedIndex, rows.length);
    this.rowsKnownFor = this.lastQuery;
    this.hasRows = rows.length > 0;
    this.emitOwnsEnter();
  }

  /**
   * Call once when the menu closes (Escape, dismissal, or the trigger text
   * stopped matching). Unconditionally forces `hasRows` back to `false`,
   * regardless of how many rows existed the instant before closing — this is
   * what stops a stale `true` from lingering past the menu actually closing —
   * and closes the `isOpen` window `setRows` checks, so anything that was
   * already in flight and arrives afterward cannot re-arm it either.
   */
  close(): void {
    this.isOpen = false;
    this.onOpenChange?.(false);
    this.rows = [];
    this.selectedIndex = 0;
    this.lastQuery = null;
    this.rowsKnownFor = null;
    this.hasRows = false;
    this.emitOwnsEnter();
  }

  /** Wraps at both ends via `moveSelection`; a no-op with zero rows. */
  move(delta: 1 | -1): void {
    if (!this.rows.length) return;
    this.selectedIndex = moveSelection(this.selectedIndex, delta, this.rows.length);
  }

  /**
   * Point the highlight at one exact row — the pointer's counterpart to
   * `move()`, used by the menus' hover handling so the row under the cursor
   * IS the selected row (one highlight, not a keyboard one plus a hover one,
   * and the `/` menu's detail pane follows the mouse).
   *
   * Returns whether the index actually moved. The caller uses that to decide
   * whether to re-render: this is driven by `pointermove`, which fires dozens
   * of times crossing a single 32px row, and every event after the first
   * names the index the state already holds. Without the check, each mouse
   * twitch would push a fresh prop set through `ReactRenderer`.
   *
   * Clamped and gated on `isOpen` for the same reasons `setRows` is — see
   * that method and the `isOpen` field comment. An out-of-range index is a
   * stale row list, not a crash.
   */
  setSelectedIndex(index: number): boolean {
    if (!this.isOpen || !this.rows.length) return false;
    const next = clampSelection(index, this.rows.length);
    if (next === this.selectedIndex) return false;
    this.selectedIndex = next;
    return true;
  }

  getSelectedIndex(): number {
    return this.selectedIndex;
  }

  getRows(): TRow[] {
    return this.rows;
  }

  getSelectedRow(): TRow | undefined {
    if (!this.rows.length) return undefined;
    return this.rows[clampSelection(this.selectedIndex, this.rows.length)];
  }

  /**
   * Does Enter belong to this menu right now?
   *
   * True while a row exists, and ALSO while the menu is open with its rows
   * for the current query still unreported — see `onOwnsEnterChange`. False
   * whenever the menu is closed, or open with a known-empty row list.
   *
   * Kept as a boundary emitter (`lastOwnsEnter`) rather than a plain call so
   * a caller's ref only flips when the answer actually changes, exactly as
   * `setHasRows` did.
   */
  ownsEnter(): boolean {
    if (!this.isOpen) return false;
    return this.hasRows || this.rowsKnownFor !== this.lastQuery;
  }

  private lastOwnsEnter = false;

  private emitOwnsEnter(): void {
    const next = this.ownsEnter();
    if (next === this.lastOwnsEnter) return;
    this.lastOwnsEnter = next;
    this.onOwnsEnterChange?.(next);
  }
}
