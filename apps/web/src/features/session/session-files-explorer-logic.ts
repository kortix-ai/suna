/**
 * Pure logic for `SessionFilesExplorer`'s `ephemeral` gate, split out purely
 * so it is unit-testable without a DOM (same reasoning as
 * `easy-panel-logic.ts`) — `SessionFilesExplorerInner` mounts a store
 * subscription and a ref, neither of which survive outside a component.
 */

import type { SessionPanelView } from '@/stores/session-browser-store';
import type { SessionPanelMode } from '@/features/session/session-version-header';

/**
 * The mode the explorer renders in.
 *
 * Non-ephemeral (Advanced) mounts derive it from the shared `viewBySession`
 * entry — the `files` view value means "Changes"; anything else (including
 * unset) means "All files". Ephemeral (Easy) mounts must not read that
 * shared state at all — Easy has no tab strip `viewBySession` could even
 * apply to, and treating it as a source here would make the toggle's
 * onChange path plausible-looking even though it must never write there
 * either — so they use the caller-owned local mode verbatim.
 */
export function deriveExplorerMode(
  ephemeral: boolean,
  localMode: SessionPanelMode,
  rawView: SessionPanelView | undefined,
): SessionPanelMode {
  if (ephemeral) return localMode;
  return rawView === 'files' ? 'changes' : 'files';
}

/**
 * The `viewBySession` value that persists a given mode, for the (Advanced)
 * path that does persist. Kept separate from the write itself so the
 * mapping is testable without a store.
 */
export function explorerViewForMode(mode: SessionPanelMode): SessionPanelView {
  return mode === 'changes' ? 'files' : 'explorer';
}

/**
 * The `lastNonce` ref's seed value on mount.
 *
 * Non-ephemeral (Advanced) mounts are the sole consumer of
 * `fileOpenBySession` and must start at 0 so a request already pending at
 * mount time (a chat file-path click that opened this tab) gets replayed —
 * that replay IS how the click reveals the file.
 *
 * Ephemeral (Easy) mounts share that request with Easy's own file-preview
 * effect, which already consumed it before the explorer ever mounts (the
 * explorer only opens on a later, explicit "Files" action). Seeding from the
 * request's current nonce instead of 0 means that already-handled request is
 * treated as already-seen, so it does not replay into the explorer and steal
 * focus onto a stale, previously-clicked path.
 */
export function initialExplorerNonce(
  ephemeral: boolean,
  pendingNonce: number | undefined,
): number {
  return ephemeral ? (pendingNonce ?? 0) : 0;
}
