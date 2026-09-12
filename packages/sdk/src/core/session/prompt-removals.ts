/**
 * Removing a prompt from the inbox, from the client's side of the wire.
 *
 * The removal itself is a plain `DELETE .../prompts/:promptId`. What lives here
 * is the part that makes the removal STICK on screen, which the request alone
 * cannot do.
 *
 * Two facts collide:
 *
 *  1. `GET .../prompts` is polled every second while rows exist, and its answers
 *     are ranked on the SERVER clock (`inboxObservationSupersedes`) so a read
 *     issued before a write can never erase what the write confirmed.
 *  2. `DELETE .../prompts/:promptId` returns the row it destroyed — and no
 *     `observed_at` at all.
 *
 * So a poll issued a few hundred milliseconds BEFORE the delete lands AFTER it,
 * carrying a strictly newer server stamp than anything the delete left behind.
 * The freshness rule accepts it, correctly by its own lights: it is the newest
 * reading anyone has. The row the user just deleted is written straight back
 * onto the screen, and the next click on its X answers 404 for a prompt the
 * server destroyed seconds ago — the "That prompt is no longer in the queue"
 * toast, stacked under the "Removed from queue" one the first click earned
 * (reported 2026-09-07 with all three toasts on screen together).
 *
 * A tombstone closes it. This tab knows the row is gone because it is the tab
 * that removed it, and that knowledge outranks any snapshot taken before the
 * delete. The tombstone is retired the moment the SERVER's own list agrees —
 * so it costs one poll, not a policy — and expires on a bound regardless, so a
 * lost confirmation can never hide a row for ever.
 *
 * Module state, deliberately: the queue cache is per-session and shared by every
 * observer of that query key, so the tombstone has to be too. Same shape as
 * `open-bundle.ts`. No framework, no globals — it runs anywhere the core does.
 */

import type { SessionPrompt } from '../rest/projects-client/sessions';

/**
 * How long a tombstone can outlive its confirmation.
 *
 * It only has to cover the flight time of a read that was already in the air
 * when the delete went out — one poll interval plus the round trip. The bound
 * exists for the case where the confirming read never arrives at all (the tab
 * is hidden, the session is switched, the network drops); past it the server's
 * list is authoritative again, which is the right default when this tab has
 * stopped being able to tell.
 */
export const PROMPT_TOMBSTONE_MAX_MS = 30_000;

export interface PromptTombstone {
  /** The removed row's id — the handle `DELETE` was issued against. */
  promptId: string;
  /**
   * Every OTHER id the row was known by. The drain re-mints a prompt's wire id,
   * so the snapshot that re-lists a removed row can legitimately name it
   * differently from the row the click removed; matching the row id alone
   * misses exactly that case.
   */
  aliases: string[];
  /** This tab's clock at removal — the bound is measured from it. */
  atMs: number;
}

const tombstonesBySession = new Map<string, PromptTombstone[]>();

/** Every id a row can be addressed by, de-duplicated and free of blanks. */
function handlesOf(prompt: SessionPrompt): string[] {
  const handles = [
    prompt.prompt_id,
    prompt.message_id,
    prompt.wire_message_id,
    prompt.client_message_id,
  ];
  return [...new Set(handles.filter((handle): handle is string => !!handle))];
}

function isLive(tombstone: PromptTombstone, nowMs: number): boolean {
  return nowMs - tombstone.atMs <= PROMPT_TOMBSTONE_MAX_MS;
}

function matches(tombstone: PromptTombstone, handle: string): boolean {
  return tombstone.promptId === handle || tombstone.aliases.includes(handle);
}

/**
 * Take one row out of the cached list by ANY handle the UI can hold.
 *
 * The route resolves a `msg_…` handle as well as the row's uuid (`r8.ts`: "A
 * prompt is named by its row id (uuid) OR by its wire message id"), because the
 * transcript bubble still knows its wire id after the row has left the list.
 * The cache has to answer the same handles the route does, or the optimistic
 * removal silently misses exactly the rows a bubble can delete.
 *
 * The removed row and its index come back so a refused delete can put it back
 * where it was, rather than rolling the whole list back over a poll that landed
 * in between.
 */
export function removeSessionPromptRow(
  prompts: readonly SessionPrompt[],
  handle: string,
): { prompts: SessionPrompt[]; removed: SessionPrompt | null; index: number } {
  const index = prompts.findIndex((prompt) => handlesOf(prompt).includes(handle));
  if (index === -1) return { prompts: [...prompts], removed: null, index: -1 };
  const removed = prompts[index]!;
  return { prompts: prompts.filter((_, at) => at !== index), removed, index };
}

/**
 * The prefix `useSessionPrompts` gives a row that exists only in this tab.
 *
 * Duplicated from `react/use-session-prompts.ts` rather than imported: this
 * module is framework-free core and that one is the React layer. The constant
 * is asserted equal in `prompt-removals.test.ts`.
 */
const OPTIMISTIC_PREFIX = 'optimistic:';

export interface PromptRemovalPlan {
  /** The list with the row taken out. */
  prompts: SessionPrompt[];
  /** The row that left, for a rollback. */
  removed: SessionPrompt | null;
  index: number;
  /**
   * Issue `DELETE .../prompts/:promptId`?
   *
   * FALSE for this tab's own optimistic row: its `prompt_id` is
   * `optimistic:<clientMessageId>`, which fails the route's id regex
   * (`r8.ts` accepts a uuid or `msg_…`) and answers 400 `Invalid prompt id`.
   * The server has never seen the prompt, so there is nothing to delete — the
   * cancel is purely local.
   *
   * TRUE when nothing matched, because the handle may still be a legitimate
   * `msg_…` for a row that has already left `GET .../prompts` — the route
   * resolves those on purpose, and that is the one way to take back a prompt
   * the daemon has persisted but no model step has read.
   */
  request: boolean;
}

/**
 * What a click on the X should actually do — see `PromptRemovalPlan.request`.
 *
 * A tombstone is written for the handle EITHER WAY, including when nothing
 * matched. That is what stops the second click repeating a request the first
 * one already proved impossible: without it a miss wrote no tombstone, so
 * `isPromptTombstoned` answered false on every repeat and each click earned
 * another 404 toast. That repeat, not a poll race, is the reproducible route to
 * the three stacked toasts reported on 2026-09-07.
 */
export function planPromptRemoval(
  prompts: readonly SessionPrompt[],
  handle: string,
  sessionId?: string,
  atMs: number = Date.now(),
): PromptRemovalPlan {
  const { prompts: next, removed, index } = removeSessionPromptRow(prompts, handle);
  if (sessionId) {
    if (removed) notePromptRemoved(sessionId, removed, atMs);
    else notePromptRemovedHandle(sessionId, handle, atMs);
  }
  return {
    prompts: next,
    removed,
    index,
    request: !removed || !removed.prompt_id.startsWith(OPTIMISTIC_PREFIX),
  };
}

/** Tombstone a bare handle — used when no cached row owns it. */
export function notePromptRemovedHandle(sessionId: string, handle: string, atMs: number): void {
  const existing = tombstonesBySession.get(sessionId) ?? [];
  if (existing.some((tombstone) => matches(tombstone, handle))) return;
  tombstonesBySession.set(sessionId, [...existing, { promptId: handle, aliases: [], atMs }]);
}

/** Put a refused removal back where it was. */
export function restoreSessionPromptRow(
  prompts: readonly SessionPrompt[],
  removed: SessionPrompt,
  index: number,
): SessionPrompt[] {
  if (prompts.some((prompt) => prompt.prompt_id === removed.prompt_id)) return [...prompts];
  const next = [...prompts];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, removed);
  return next;
}

/** Record that THIS tab removed this row, so no older snapshot can re-list it. */
export function notePromptRemoved(sessionId: string, prompt: SessionPrompt, atMs: number): void {
  const handles = handlesOf(prompt);
  const existing = tombstonesBySession.get(sessionId) ?? [];
  tombstonesBySession.set(sessionId, [
    ...existing.filter((tombstone) => !handles.some((handle) => matches(tombstone, handle))),
    { promptId: prompt.prompt_id, aliases: handles.filter((h) => h !== prompt.prompt_id), atMs },
  ]);
}

/** Is this handle one this tab has already removed? */
export function isPromptTombstoned(sessionId: string, handle: string, nowMs = Date.now()): boolean {
  return (tombstonesBySession.get(sessionId) ?? []).some(
    (tombstone) => isLive(tombstone, nowMs) && matches(tombstone, handle),
  );
}

/** This session's live tombstones — observable so a host can reason about them. */
export function promptTombstones(sessionId: string, nowMs = Date.now()): PromptTombstone[] {
  return (tombstonesBySession.get(sessionId) ?? []).filter((tombstone) => isLive(tombstone, nowMs));
}

/**
 * Hide the rows this tab removed from a snapshot that still lists them.
 *
 * Called on every reading of the list, so a stale in-flight poll cannot put a
 * deleted row back on screen between the DELETE and the read that confirms it.
 */
export function applyPromptTombstones(
  sessionId: string,
  prompts: readonly SessionPrompt[],
  nowMs = Date.now(),
): SessionPrompt[] {
  const live = promptTombstones(sessionId, nowMs);
  if (live.length === 0) return [...prompts];
  return prompts.filter(
    (prompt) =>
      !handlesOf(prompt).some((handle) =>
        live.some((tombstone) => matches(tombstone, handle)),
      ),
  );
}

/**
 * Retire the tombstones the SERVER has now confirmed.
 *
 * A snapshot that no longer lists the prompt is the control plane agreeing the
 * delete happened, which is the only thing the tombstone was ever waiting for.
 * Expired ones go at the same time.
 */
export function prunePromptTombstones(
  sessionId: string,
  serverPrompts: readonly SessionPrompt[],
  nowMs = Date.now(),
): void {
  const listed = new Set(serverPrompts.flatMap(handlesOf));
  const kept = (tombstonesBySession.get(sessionId) ?? []).filter(
    (tombstone) =>
      isLive(tombstone, nowMs) &&
      (listed.has(tombstone.promptId) || tombstone.aliases.some((alias) => listed.has(alias))),
  );
  if (kept.length === 0) tombstonesBySession.delete(sessionId);
  else tombstonesBySession.set(sessionId, kept);
}

/**
 * Lift tombstones deliberately.
 *
 * With no arguments: everything (tests, sign-out). With a session: that
 * session's. With a handle as well: the ONE row — which is what an undo needs,
 * because it re-POSTs the original `client_message_id` and the row the server
 * hands back is precisely the one this tab tombstoned. Without the lift the
 * restored prompt would be filtered off the screen under a button that says
 * "Undo".
 */
export function clearPromptTombstones(sessionId?: string, handle?: string): void {
  if (!sessionId) {
    tombstonesBySession.clear();
    return;
  }
  if (!handle) {
    tombstonesBySession.delete(sessionId);
    return;
  }
  const kept = (tombstonesBySession.get(sessionId) ?? []).filter(
    (tombstone) => !matches(tombstone, handle),
  );
  if (kept.length === 0) tombstonesBySession.delete(sessionId);
  else tombstonesBySession.set(sessionId, kept);
}

/**
 * Apply a new send order to the cached list — the optimistic half of a drag.
 *
 * `promptIds` is the order the queue list just produced, top first. Only the
 * rows it NAMES are rearranged: the list renders the parked prompts, so
 * anything else in the cache (a prompt sent with plain Enter, one queued from
 * another device) keeps its relative position instead of being swept to one end
 * by a drag that never referred to it. Ids naming no row are ignored.
 *
 * The named rows take the earliest slots the named rows already occupied, which
 * mirrors what `reorderInboxPrompts` does on the server: pack the new order
 * into the span those rows already had, so the arrangement is local to the list.
 */
export function applyPromptOrder(
  prompts: readonly SessionPrompt[],
  promptIds: readonly string[],
): SessionPrompt[] {
  const named = new Set(promptIds);
  const slots: number[] = [];
  prompts.forEach((prompt, index) => {
    if (named.has(prompt.prompt_id)) slots.push(index);
  });
  if (slots.length === 0) return [...prompts];

  const byId = new Map(prompts.map((prompt) => [prompt.prompt_id, prompt] as const));
  const ordered = promptIds
    .map((id) => byId.get(id))
    .filter((prompt): prompt is SessionPrompt => !!prompt);

  const next = [...prompts];
  slots.forEach((slot, index) => {
    const prompt = ordered[index];
    if (prompt) next[slot] = prompt;
  });
  return next;
}
