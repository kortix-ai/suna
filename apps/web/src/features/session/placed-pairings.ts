import type { SessionPlacedPrompt } from '@kortix/sdk';

/**
 * What the tab does with `useSessionPrompts().placed` — the pairings of inbox
 * rows that already LEFT the pending list.
 *
 * Every prompt this tab sends is painted into the transcript on Enter under
 * its client WIRE id, then POSTed, and its bubble is inbox-backed: the sync
 * store retires it ONLY through the row's announced pairing
 * (`registerOptimisticEcho(wire_message_id → message_id)`), never by the
 * ordinal fallback (which, with a burst in flight, handed one bubble another
 * message's text — measured), and never by part id (the server drops the
 * client's part ids, `sanitizeInboxPromptParts`).
 *
 * The pairing exists on the row only between the drain's re-mint and the row
 * leaving `GET .../prompts`. For a steer the row is confirmed `delivered` at
 * ACCEPTANCE, often under 1 s after the re-mint, and this tab polls every
 * 1 s. Miss that one poll and the runtime's echo (re-minted id) lands as a
 * NEW placed message while the stub (client id, "just now", Thinking) stays
 * until reload — 2026-09-22, preview session "YO" 134c0d27, bubbles 4 and 5
 * of the user's screenshot. The server now keeps the pairing for ten minutes
 * after the row as `placed` (a hidden tab polls nothing and reads once on
 * focus); these two helpers are the tab's side of it.
 */

export interface PlacedEchoPairing {
  /** The id the bubble was painted under. */
  wireMessageId: string;
  /** An id the runtime's echo carries. */
  messageId: string;
}

/**
 * Every id a placed row was delivered under, deduplicated, `message_id` LAST.
 *
 * The server lists `message_ids` latest first. The store keeps ONE forward
 * alias per bubble — the last registration — and that alias is what the
 * echo's `message.updated` is matched on first. Announced latest-first, a
 * row re-minted more than once left the OLDEST id standing, and the latest
 * echo landed beside the bubble (review finding, 2026-09-22). The store now
 * matches every registered pairing whichever came last, and this order keeps
 * the standing alias — the identity a host keys on — the id the echo carries.
 */
function deliveredIds(placed: SessionPlacedPrompt): string[] {
  const ids: string[] = [];
  for (const id of [...(placed.message_ids ?? []), placed.message_id]) {
    if (!id || id === placed.wire_message_id || id === placed.message_id) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  if (placed.message_id && placed.message_id !== placed.wire_message_id) ids.push(placed.message_id);
  return ids;
}

/**
 * The (wire id → delivered id) pairs to announce to the sync store, one per
 * delivered id: a redelivery can leave the echo under an EARLIER re-minted
 * id. The store's retire-on-late-alias rule then retires the stub on the
 * spot when the echo is already on screen.
 */
export function placedEchoPairings(
  placed: readonly SessionPlacedPrompt[] | undefined,
): PlacedEchoPairing[] {
  const pairings: PlacedEchoPairing[] = [];
  for (const row of placed ?? []) {
    if (!row.wire_message_id) continue;
    for (const messageId of deliveredIds(row)) {
      pairings.push({ wireMessageId: row.wire_message_id, messageId });
    }
  }
  return pairings;
}

/**
 * Fold placed pairings into the "already on screen" id set the queue
 * projection reads (`transcriptUserMessageIds`): a pairing with ANY of its
 * ids on screen claims every id it names, and the client id — the same
 * treatment a live row gets, so a cached row whose poll the freshness rule
 * discarded is still hidden by its wire id after the stub is retired.
 */
export function claimPlacedPairingIds(
  ids: Set<string>,
  placed: readonly SessionPlacedPrompt[] | undefined,
): void {
  for (const row of placed ?? []) {
    const own = [row.wire_message_id, ...deliveredIds(row)].filter(Boolean);
    if (!own.some((id) => ids.has(id))) continue;
    for (const id of own) ids.add(id);
    if (row.client_message_id) ids.add(row.client_message_id);
  }
}
