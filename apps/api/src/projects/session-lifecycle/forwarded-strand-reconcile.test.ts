import { describe, expect, test } from 'bun:test';
import type { StoredSandboxTurn } from '../sandbox-turn-lifecycle';
import { WIRE_ID_TIME_SCALE, wireIdTime } from '../wire-message-id';
import type { PlacementTipMessage } from './forwarded-placement';
import { type StrandReconcileDeps, reconcileForwardedTurnsAtEnd } from './forwarded-strand-reconcile';

const id = (ms: number, tail: string) =>
  `msg_${((BigInt(ms) * WIRE_ID_TIME_SCALE + BigInt(1)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0')}${tail}`;

/** The millisecond an id's clock encodes — what the box would have stamped as
 *  `time.created` if it had minted that id itself. */
const at = (messageId: string): number => Number(wireIdTime(messageId)! / WIRE_ID_TIME_SCALE);

/**
 * Fill in `time.created` for every fixture message that does not set one.
 *
 * These fixtures were written before the functions under test read
 * `time.created` at all, so each one describes ORDER through the id clock
 * only — which means an id-ordered implementation and a `time.created`-ordered
 * one pass them identically and neither can be caught regressing. Stamping
 * each message with the millisecond its own id already encodes keeps every
 * existing assertion exactly as it was (the two orders agree by construction)
 * while making the fixtures able to express a DISAGREEMENT. The tests that
 * need one pass `created` explicitly; it wins over the fill.
 */
const tipOf = (messages: PlacementTipMessage[]): PlacementTipMessage[] =>
  messages.map((m) => ({ created: at(m.id), ...m }));

const T = 1_800_000_000_000;
const turn = (messageId: string, state: 'delivering' | 'active' = 'active'): StoredSandboxTurn => ({
  token: `tok-${messageId}`,
  state,
  messageId,
  opencodeSessionId: 'ses_root',
  startedAtMs: T,
});

function fakeDeps(over: Partial<StrandReconcileDeps> & { open: StoredSandboxTurn[]; tip: any[] | null }) {
  const calls: Record<string, unknown[][]> = { closeOlder: [], closeStranded: [], remove: [], requeue: [], kick: [] };
  const deps: StrandReconcileDeps = {
    readOpenTurns: async () => over.open,
    closeOlderTurn: async (...a) => { calls.closeOlder.push(a); },
    closeStrandedTurn: async (...a) => { calls.closeStranded.push(a); },
    readTip: async () => over.tip,
    removeMessage: async (...a) => { calls.remove.push(a); return true; },
    requeueStranded: async (...a) => { calls.requeue.push(a); return 'requeued'; },
    kickDrain: (...a) => { calls.kick.push(a); },
    ...over,
  };
  return { deps, calls };
}

describe('reconcileForwardedTurnsAtEnd', () => {
  const u1 = id(T, 'USER1USER1USER');
  const u2 = id(T + 1_000, 'USER2USER2USER');
  const M = id(T + 2_000, 'USERMUSERMUSER');
  const aM = id(T + 3_000, 'ASSTMASSTMASST');
  const u4 = id(T + 2_500, 'USER4USER4USER'); // landed below aM, never read
  const u5 = id(T + 4_000, 'USER5USER5USER'); // a fresh send after the end

  test('no-op without an ended message id when the tip has no finished assistant either', async () => {
    const { deps, calls } = fakeDeps({ open: [turn(u1)], tip: [] });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's' }, deps);
    expect(out).toEqual({ closedOlder: 0, candidates: 0, stranded: 0, orphaned: 0, requeued: 0, reordered: 0 });
    expect(calls.closeOlder).toHaveLength(0);
  });

  test('a relay that names no message falls back to the newest finished assistant\'s parent', async () => {
    // The daemon could not attribute the end; the tip can: the step that
    // ended answered M, and u4 sits above M below its assistant — stranded.
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u1), turn(u4, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's' }, deps);
    expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 1, orphaned: 0, requeued: 1, reordered: 0 });
    expect(calls.closeOlder.map((c) => c[2])).toEqual([u1]);
    expect(calls.remove).toEqual([['s', u4]]);
  });

  // FAILS on the pre-2026-08-20 `m.id > newest.id` string compare in the
  // relay fallback. Two FINISHED assistants are ordered one way by id and the
  // OTHER way by `time.created` — the order the box itself stamped and the
  // order `MessageV2.page()` returns. Picking the wrong one names the wrong
  // `endedMessageId`, which flips every open turn between "answered, close it"
  // and "newer, inspect it".
  test('the relay fallback picks the newest finished assistant by time.created, not by id string order', async () => {
    const m1 = id(T + 1_000, 'USERM1USERM1US');
    const m2 = id(T + 5_000, 'USERM2USERM2US');
    // Higher id, stamped EARLIER — an assistant the box wrote first under a
    // lifted/under-placed neighbour's clock.
    const aHigh = id(T + 9_000, 'ASSTHIASSTHIAS');
    // Lower id, stamped LATER — the step that actually ended last.
    const aLow = id(T + 1_500, 'ASSTLOASSTLOAS');
    const x = id(T + 3_000, 'USERXUSERXUSER');
    const tip = [
      { id: m1, role: 'user', created: T + 1_000 },
      { id: aHigh, role: 'assistant', parentID: m1, created: T + 2_000, completed: T + 2_100 },
      { id: x, role: 'user', created: T + 3_000 },
      { id: m2, role: 'user', created: T + 5_000 },
      { id: aLow, role: 'assistant', parentID: m2, created: T + 8_000, completed: T + 8_100 },
    ];
    const { deps, calls } = fakeDeps({ open: [turn(x, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's' }, deps);
    // time order -> endedMessageId = m2 (clock T+5000) -> x (T+3000) is OLDER,
    // so the step that ended answered it and its ledger row closes.
    // id order   -> endedMessageId = m1 (clock T+1000) -> x is NEWER, a candidate.
    expect(out.closedOlder).toBe(1);
    expect(calls.closeOlder.map((c) => c[2])).toEqual([x]);
    expect(out.candidates).toBe(0);
    expect(calls.remove).toHaveLength(0);
  });

  test('older forwarded turns close as completed; the ended one is left to the relay', async () => {
    const { deps, calls } = fakeDeps({ open: [turn(u1), turn(u2), turn(M)], tip: [] });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M }, deps);
    expect(out.closedOlder).toBe(2);
    expect(calls.closeOlder.map((c) => c[2])).toEqual([u1, u2]);
    expect(out.candidates).toBe(0);
  });

  test('a stranded newer prompt is removed, re-queued, its turn closed, and the drain kicked', async () => {
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M }, deps);
    expect(out).toEqual({ closedOlder: 0, candidates: 1, stranded: 1, orphaned: 0, requeued: 1, reordered: 0 });
    expect(calls.remove).toEqual([['s', u4]]);
    expect(calls.requeue).toEqual([['s', u4]]);
    expect(calls.closeStranded).toEqual([['s', u4]]);
    expect(calls.kick).toHaveLength(1);
  });

  test('a newer prompt that opened its own turn is left alone', async () => {
    const a5 = id(T + 4_100, 'ASST5ASST5ASST');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
      { id: u5, role: 'user' },
      { id: a5, role: 'assistant', parentID: u5 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u5)], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M }, deps);
    expect(out).toEqual({ closedOlder: 0, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0 });
    expect(calls.remove).toHaveLength(0);
    expect(calls.closeStranded).toHaveLength(0);
  });

  // EXPECTATION FLIPPED 2026-08-20 (live incident, Essentia session
  // d1b74954): an unreached prompt at the TIP with the loop exited (the tip's
  // newest assistant is COMPLETED) is not "in line" — nothing will ever read
  // it. Left alone, the reaper cleared its turn `unknown` and the prompt was
  // swallowed. It now requeues exactly like a stranded row.
  test('an ACCEPTED tip prompt the exited loop never read is removed and re-queued', async () => {
    const tip = tipOf([{ id: M, role: 'user' }, { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 }, { id: u5, role: 'user' }]);
    const { deps, calls } = fakeDeps({ open: [turn(u5)], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.stranded).toBe(0);
    expect(out.orphaned).toBe(1);
    expect(out.requeued).toBe(1);
    expect(calls.remove).toEqual([['s', u5]]);
    expect(calls.requeue).toEqual([['s', u5]]);
    expect(calls.closeStranded).toEqual([['s', u5]]);
  });

  test('a tip prompt is left alone while the tip is MID-STEP — the open step will read it', async () => {
    const aOpen = id(T + 4_100, 'ASSTOASSTOASST');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
      { id: u5, role: 'user' },
      { id: aOpen, role: 'assistant', parentID: u5 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u5)], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.orphaned).toBe(0);
    expect(calls.remove).toHaveLength(0);
  });

  test('a DELIVERING tip prompt is left alone — the send is still on the wire', async () => {
    const tip = tipOf([{ id: M, role: 'user' }, { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 }, { id: u5, role: 'user' }]);
    const { deps, calls } = fakeDeps({ open: [turn(u5, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.orphaned).toBe(0);
    expect(calls.remove).toHaveLength(0);
  });

  test('a candidate absent from the tip window is left to the reaper', async () => {
    const tip = tipOf([{ id: M, role: 'user' }, { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 }]);
    const { deps, calls } = fakeDeps({ open: [turn(u5)], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.orphaned).toBe(0);
    expect(calls.remove).toHaveLength(0);
  });

  test('an unreadable tip skips the strand check but still closes older turns', async () => {
    const { deps, calls } = fakeDeps({ open: [turn(u1), turn(u4)], tip: null });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.closedOlder).toBe(1);
    expect(out.stranded).toBe(0);
    expect(calls.remove).toHaveLength(0);
  });

  test('a failed removal never re-queues (no duplicate), the turn stays', async () => {
    const tip = tipOf([{ id: M, role: 'user' }, { id: u4, role: 'user' }, { id: aM, role: 'assistant', parentID: M }]);
    const { deps, calls } = fakeDeps({ open: [turn(u4)], tip, removeMessage: async () => false });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', endedMessageId: M }, deps);
    expect(out.stranded).toBe(1);
    expect(out.requeued).toBe(0);
    expect(calls.requeue).toHaveLength(0);
    expect(calls.closeStranded).toHaveLength(0);
  });

  test('a stranded row with a later OPEN sibling above it is left in place — that sibling\'s step answers both', async () => {
    // u4 stranded below aM; u5 landed fine above it and is still unanswered.
    // OpenCode's next step parents on u5 and hands the model the whole
    // transcript — u4 included — so pulling u4 back out would only reorder
    // the user's messages. Nothing is removed or re-queued.
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
      { id: u5, role: 'user' },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering'), turn(u5, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd(
      { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M },
      deps,
    );
    expect(out).toEqual({ closedOlder: 0, candidates: 2, stranded: 1, orphaned: 0, requeued: 0, reordered: 0 });
    expect(calls.remove).toHaveLength(0);
    expect(calls.requeue).toHaveLength(0);
  });

  test('a fully stranded TAIL re-queues as a whole, so the batch re-mints it in order', async () => {
    // Both u4 and u5 are stranded below aM — the loop exited without either.
    // Both come back; the drain's batch re-mints them by send order.
    const u5b = id(T + 2_600, 'USER5BUSER5BUS');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user' },
      { id: u5b, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering'), turn(u5b, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd(
      { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M },
      deps,
    );
    expect(out.stranded).toBe(2);
    expect(out.requeued).toBe(2);
    expect(calls.remove).toEqual([
      ['s', u4],
      ['s', u5b],
    ]);
  });

  test('a later sibling a step already REACHED stays put (cannot be pulled back)', async () => {
    const a5 = id(T + 4_100, 'ASST5ASST5ASST');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user' },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
      { id: u5, role: 'user' },
      { id: a5, role: 'assistant', parentID: u5 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering'), turn(u5, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd(
      { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M },
      deps,
    );
    expect(out.requeued).toBe(1);
    expect(out.reordered).toBe(0);
    expect(calls.remove).toEqual([['s', u4]]);
  });

  test('turns of another opencode root are ignored', async () => {
    const foreign = { ...turn(u1), opencodeSessionId: 'ses_child' };
    const { deps, calls } = fakeDeps({ open: [foreign], tip: [] });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M }, deps);
    expect(out.closedOlder).toBe(0);
    expect(calls.closeOlder).toHaveLength(0);
  });
});
