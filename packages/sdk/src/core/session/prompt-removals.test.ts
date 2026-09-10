import { beforeEach, describe, expect, test } from 'bun:test';
import type { SessionPrompt } from '../rest/projects-client/sessions';
import {
  PROMPT_TOMBSTONE_MAX_MS,
  applyPromptOrder,
  applyPromptTombstones,
  clearPromptTombstones,
  isPromptTombstoned,
  notePromptRemoved,
  planPromptRemoval,
  promptTombstones,
  prunePromptTombstones,
  removeSessionPromptRow,
} from './prompt-removals';

function prompt(over: Partial<SessionPrompt> & { prompt_id: string }): SessionPrompt {
  return {
    client_message_id: `cli_${over.prompt_id}`,
    message_id: `msg_${over.prompt_id}`,
    state: 'queued',
    reason: null,
    text: over.prompt_id,
    attempts: 0,
    last_error: null,
    created_at: '2026-09-08T00:00:00.000Z',
    available_at: '2026-09-08T00:00:00.000Z',
    ...over,
  };
}

/**
 * The X takes the row off the screen on the CLICK, not on the round-trip.
 *
 * `removeMutation` used to carry no `onMutate` at all, so the row stayed fully
 * rendered — and fully clickable — for the whole `DELETE`. A second click in
 * that window is the 404 the user reads as "That prompt is no longer in the
 * queue", stacked under the "Removed from queue" toast the first click earned.
 */
describe('removeSessionPromptRow', () => {
  test('drops the row named by its prompt id, and reports what it took', () => {
    const rows = [prompt({ prompt_id: 'a' }), prompt({ prompt_id: 'b' })];
    const out = removeSessionPromptRow(rows, 'b');
    expect(out.prompts.map((p) => p.prompt_id)).toEqual(['a']);
    expect(out.removed?.prompt_id).toBe('b');
    expect(out.index).toBe(1);
  });

  /**
   * `DELETE .../prompts/:promptId` resolves a `msg_…` handle too (r8.ts: "A
   * prompt is named by its row id (uuid) OR by its wire message id"), and the
   * transcript bubble is the surface that still holds one after the row has
   * left the list. The cache has to answer the same handles the route does, or
   * the optimistic removal misses exactly the rows the bubble can delete.
   */
  test('drops the row named by its wire message id', () => {
    const rows = [prompt({ prompt_id: 'a' }), prompt({ prompt_id: 'b' })];
    expect(removeSessionPromptRow(rows, 'msg_b').removed?.prompt_id).toBe('b');
  });

  test('drops the row named by the id the drain re-minted it under', () => {
    const rows = [prompt({ prompt_id: 'a', wire_message_id: 'msg_original' })];
    expect(removeSessionPromptRow(rows, 'msg_original').removed?.prompt_id).toBe('a');
  });

  test('an unknown handle changes nothing and removes nothing', () => {
    const rows = [prompt({ prompt_id: 'a' })];
    const out = removeSessionPromptRow(rows, 'nope');
    expect(out.prompts).toHaveLength(1);
    expect(out.removed).toBeNull();
    expect(out.index).toBe(-1);
  });
});

/**
 * A tombstone is what makes the removal STICK.
 *
 * Optimistic removal alone cannot: the `DELETE` response carries no
 * `observed_at`, so a `GET .../prompts` issued BEFORE the delete lands after it
 * with a strictly NEWER server stamp. `inboxObservationSupersedes` accepts it —
 * correctly, it is the newest reading — and writes the row the user just
 * deleted straight back onto the screen. Then they click the X again, and the
 * server answers 404 for a row it destroyed seconds ago.
 */
describe('prompt tombstones', () => {
  beforeEach(() => clearPromptTombstones());

  test('a removed row is filtered out of a snapshot that still lists it', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    const stale = [prompt({ prompt_id: 'a' }), prompt({ prompt_id: 'b' })];
    const out = applyPromptTombstones('ses_1', stale, 1_100);
    expect(out.map((p) => p.prompt_id)).toEqual(['b']);
  });

  test('the tombstone is scoped to its session', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    const rows = [prompt({ prompt_id: 'a' })];
    expect(applyPromptTombstones('ses_2', rows, 1_100)).toHaveLength(1);
  });

  /**
   * The row is filtered by every id it has ever had. The drain RE-MINTS a
   * prompt's wire id, so the snapshot that re-lists it can name it differently
   * from the row the click removed.
   */
  test('filters by wire and client id, not only the row id', () => {
    notePromptRemoved(
      'ses_1',
      prompt({ prompt_id: 'a', wire_message_id: 'msg_old', client_message_id: 'cli_a' }),
      1_000,
    );
    const reminted = [prompt({ prompt_id: 'a2', message_id: 'msg_new', client_message_id: 'cli_a' })];
    expect(applyPromptTombstones('ses_1', reminted, 1_100)).toHaveLength(0);
  });

  /**
   * The tombstone exists to outlive ONE stale read, not to hide a row for ever.
   * The server agreeing is what retires it: a snapshot that no longer lists the
   * prompt is the control plane confirming the delete.
   */
  test('a snapshot that agrees the row is gone retires the tombstone', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    prunePromptTombstones('ses_1', [prompt({ prompt_id: 'b' })], 1_100);
    expect(isPromptTombstoned('ses_1', 'a')).toBe(false);
  });

  test('a snapshot that still lists the row keeps the tombstone', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    prunePromptTombstones('ses_1', [prompt({ prompt_id: 'a' })], 1_100);
    expect(isPromptTombstoned('ses_1', 'a', 1_100)).toBe(true);
  });

  /**
   * A bound, because a tombstone that never expires is a row the user can never
   * get back — an undo re-POSTs the SAME `client_message_id`, and the restored
   * row would be filtered out by its own tombstone for ever.
   */
  test('a tombstone expires on its own', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    expect(isPromptTombstoned('ses_1', 'a', 1_000 + PROMPT_TOMBSTONE_MAX_MS + 1)).toBe(false);
    const rows = [prompt({ prompt_id: 'a' })];
    expect(applyPromptTombstones('ses_1', rows, 1_000 + PROMPT_TOMBSTONE_MAX_MS + 1)).toHaveLength(1);
  });

  /**
   * UNDO is the reason a tombstone can be lifted deliberately. The undo
   * re-POSTs the original `client_message_id`, so the row the server hands back
   * is the one this tab just tombstoned — and without the lift the restored
   * prompt would be filtered off the screen under a button labelled "Undo".
   */
  test('a tombstone can be lifted so an undo can put the row back', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    clearPromptTombstones('ses_1', 'cli_a');
    expect(applyPromptTombstones('ses_1', [prompt({ prompt_id: 'a' })], 1_100)).toHaveLength(1);
  });

  /**
   * The second click is the one that produces the 404 toast. With the row
   * already tombstoned the host has a cheap, synchronous way to refuse it
   * before a request is ever issued.
   */
  test('a removed row reports as tombstoned by every handle the UI can hold', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a', wire_message_id: 'msg_w' }), 1_000);
    expect(isPromptTombstoned('ses_1', 'a', 1_100)).toBe(true);
    expect(isPromptTombstoned('ses_1', 'msg_a', 1_100)).toBe(true);
    expect(isPromptTombstoned('ses_1', 'msg_w', 1_100)).toBe(true);
    expect(isPromptTombstoned('ses_1', 'cli_a', 1_100)).toBe(true);
    expect(isPromptTombstoned('ses_1', 'someone-else', 1_100)).toBe(false);
  });

  test('the registry is observable so a host can reason about it', () => {
    notePromptRemoved('ses_1', prompt({ prompt_id: 'a' }), 1_000);
    expect(promptTombstones('ses_1', 1_100).map((t) => t.promptId)).toEqual(['a']);
    expect(promptTombstones('ses_2', 1_100)).toEqual([]);
  });
});

/**
 * WHAT A CLICK ON THE X SHOULD ACTUALLY DO.
 *
 * Three cases, and only one of them is a plain `DELETE`:
 *
 *  1. A real server row → issue the request against its `prompt_id`.
 *  2. THIS TAB'S OWN OPTIMISTIC ROW → the server has never seen it. Its
 *     `prompt_id` is `optimistic:<clientMessageId>`, which fails the route's id
 *     regex and answers 400 `Invalid prompt id`. Cancel it locally instead.
 *  3. No cached row at all → the handle may still be a legitimate `msg_…` for a
 *     row that has left the list (the route resolves those), so the request
 *     stands. But a tombstone is written either way, so the SECOND click is
 *     refused locally instead of repeating the same 404 — which is how the
 *     stacked-toast screenshot was actually reproduced.
 */
describe('planPromptRemoval', () => {
  beforeEach(() => clearPromptTombstones());

  test('a real server row is removed locally AND requested', () => {
    const rows = [prompt({ prompt_id: 'p1' })];
    const plan = planPromptRemoval(rows, 'p1');
    expect(plan.request).toBe(true);
    expect(plan.removed?.prompt_id).toBe('p1');
    expect(plan.prompts).toHaveLength(0);
  });

  test("this tab's own optimistic row is cancelled locally, never requested", () => {
    const rows = [prompt({ prompt_id: 'optimistic:cli_1', client_message_id: 'cli_1' })];
    const plan = planPromptRemoval(rows, 'optimistic:cli_1');
    expect(plan.request).toBe(false);
    expect(plan.removed?.prompt_id).toBe('optimistic:cli_1');
    expect(plan.prompts).toHaveLength(0);
  });

  test('an unknown handle still requests — it may name a row that left the list', () => {
    const plan = planPromptRemoval([prompt({ prompt_id: 'p1' })], 'msg_gone');
    expect(plan.request).toBe(true);
    expect(plan.removed).toBeNull();
  });
});

/**
 * THE OPTIMISTIC SIDE OF THE DRAG.
 *
 * The server rewrites `clientSentAtMs` and answers with the whole list, but
 * that is a round trip. A row that snaps back to its old slot for the duration
 * reads as the drag having failed, so the drop is applied to the cache in the
 * same frame and the server's answer replaces it.
 */
describe('applyPromptOrder', () => {
  const rows = [
    prompt({ prompt_id: 'a' }),
    prompt({ prompt_id: 'b' }),
    prompt({ prompt_id: 'c' }),
  ];

  test('puts the named rows in the order given', () => {
    expect(applyPromptOrder(rows, ['c', 'a', 'b']).map((p) => p.prompt_id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  /**
   * The list only ever names the rows it renders — the parked ones. Anything
   * else (a prompt sent with plain Enter, one from another device) keeps its
   * place rather than being swept to an end by a drag that never referred to it.
   */
  test('rows the caller did not name keep their relative order, after the named ones', () => {
    const mixed = [...rows, prompt({ prompt_id: 'd' }), prompt({ prompt_id: 'e' })];
    // `b` never moves: it keeps the slot it had. The two named rows swap the
    // slots THEY had (0 and 2), which is exactly what the server does by
    // dealing the rows their own sorted stamps back out.
    expect(applyPromptOrder(mixed, ['c', 'a']).map((p) => p.prompt_id)).toEqual([
      'c',
      'b',
      'a',
      'd',
      'e',
    ]);
  });

  test('an id that names no row is ignored rather than shifting everything', () => {
    expect(applyPromptOrder(rows, ['c', 'ghost', 'a']).map((p) => p.prompt_id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  test('an empty order changes nothing', () => {
    expect(applyPromptOrder(rows, []).map((p) => p.prompt_id)).toEqual(['a', 'b', 'c']);
  });
});
