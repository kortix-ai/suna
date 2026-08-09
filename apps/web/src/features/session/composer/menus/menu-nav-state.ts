import { clampSelection, moveSelection } from './menu-selection';

export interface MenuNavStateOptions {
  /**
   * Fires ONLY on the false<->true boundary — same discipline as
   * `trackEmptyBoundary` (`editor/composer-editor.tsx`) — so a caller's ref
   * only flips when the answer actually changes.
   *
   * This is what the Enter-to-submit guard in `composer-editor.tsx` reads.
   * It answers "does a selectable row exist right now", never "is a trigger
   * match merely active". A `@`/`/` match with zero rows (e.g.
   * `@nonexistentfile`, or `/xyzzy`) must leave this `false` the whole time
   * it is open, so Enter falls through to submit exactly like the live
   * `session-chat-input.tsx:932`/`:958`/`:990` guards
   * (`mentionItems.length > 0`, `filteredCommands.length > 0`) — not stay
   * `true` from open to close and block Enter from doing anything at all.
   */
  onHasRowsChange?: (hasRows: boolean) => void;
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
  private readonly onHasRowsChange?: (hasRows: boolean) => void;

  constructor(options: MenuNavStateOptions = {}) {
    this.onHasRowsChange = options.onHasRowsChange;
  }

  /** Call once when a new trigger match starts (the menu just opened). */
  open(query: string): void {
    this.isOpen = true;
    this.rows = [];
    this.selectedIndex = 0;
    this.lastQuery = query;
    this.setHasRows(false);
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
  }

  /**
   * Call whenever the row list is recomputed — synchronously on every
   * keystroke for the `/` menu, or asynchronously whenever `useFileSearch`
   * resolves for the `@` menu. Clamps the index (handles the list shrinking
   * under a stationary query) and is the single source of truth for
   * `onHasRowsChange` — see that option's own doc comment for why this must
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
    this.setHasRows(rows.length > 0);
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
    this.rows = [];
    this.selectedIndex = 0;
    this.lastQuery = null;
    this.setHasRows(false);
  }

  /** Wraps at both ends via `moveSelection`; a no-op with zero rows. */
  move(delta: 1 | -1): void {
    if (!this.rows.length) return;
    this.selectedIndex = moveSelection(this.selectedIndex, delta, this.rows.length);
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

  private setHasRows(next: boolean): void {
    if (this.hasRows === next) return;
    this.hasRows = next;
    this.onHasRowsChange?.(next);
  }
}
