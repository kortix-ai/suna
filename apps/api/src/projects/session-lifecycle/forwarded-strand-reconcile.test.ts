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
  const calls: Record<string, unknown[][]> = { closeOlder: [], closeStranded: [], remove: [], requeue: [], kick: [], readMessage: [] };
  const deps: StrandReconcileDeps = {
    readOpenTurns: async () => over.open,
    closeOlderTurn: async (...a) => { calls.closeOlder.push(a); },
    closeStrandedTurn: async (...a) => { calls.closeStranded.push(a); },
    readTip: async () => over.tip,
    readMessage: async (...a) => { calls.readMessage.push(a); return null; },
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

  test('every turn end sweeps the copies a Remove emptied — including one with nothing to reconcile', async () => {
    // A Remove during a tool loop empties the steer (the busy loop refuses a
    // whole-message delete) and closes its ledger turn. At the loop's own end
    // no forwarded turn is open, and the reconciliation returns before any
    // tip read — which is where the only husk sweep used to live.
    const swept: string[] = [];
    const { deps } = fakeDeps({
      open: [],
      tip: null,
      sweepHusks: async (sessionId) => {
        swept.push(sessionId);
      },
    });
    await reconcileForwardedTurnsAtEnd({ sessionId: 's-husk' }, deps);
    expect(swept).toEqual(['s-husk']);

    // A failing sweep never fails the reconciliation.
    const failing = fakeDeps({
      open: [],
      tip: null,
      sweepHusks: async () => {
        throw new Error('box gone');
      },
    });
    await expect(reconcileForwardedTurnsAtEnd({ sessionId: 's-husk' }, failing.deps)).resolves.toBeDefined();
  });

  test('no-op without an ended message id when the tip has no finished assistant either', async () => {
    const { deps, calls } = fakeDeps({ open: [turn(u1)], tip: [] });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's' }, deps);
    expect(out).toEqual({ closedOlder: 0, candidates: 0, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
    expect(calls.closeOlder).toHaveLength(0);
  });

  test('a relay that names no message falls back to the newest finished assistant\'s parent', async () => {
    // The daemon could not attribute the end; the tip can: the step that
    // ended answered M, and u4 sits above M below its assistant — stranded.
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user', created: T + 3_200 }, // persisted after aM's step began
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u1), turn(u4, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's' }, deps);
    expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 1, orphaned: 0, requeued: 1, reordered: 0, closedRead: 0 });
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

  // THE SEND-ORDER GATE'S CONSEQUENCE AT TURN END. With the gate (queued-continue.ts,
  // `underPlacementKeepsSendOrder`) BRAVO — sent after ALPHA — is re-minted
  // ABOVE ALPHA's lifted id instead of under-placed below it. The merged
  // reply parents on BRAVO (newest by `time.created`), the relay names BRAVO,
  // and ALPHA is an OLDER forwarded turn: closed `completed`. Nothing is
  // stranded, nothing is re-queued, no second paid answer. (Before the gate
  // BRAVO sat BELOW ALPHA by id, ALPHA was the NEWER candidate, and the
  // stamps were the only thing standing between it and a re-queue.)
  test('a lifted ALPHA below a re-minted BRAVO is an older turn — closed completed, never re-queued', async () => {
    const alpha = id(T + 2_000, 'ALPHAALPHAALPH'); // lifted to the box clock; persisted T+1000
    const bravo = id(T + 2_500, 'BRAVOBRAVOBRAV'); // re-minted above alpha; persisted T+1200
    const merged = id(T + 3_000, 'MERGEMERGEMERG');
    const tip: PlacementTipMessage[] = [
      { id: alpha, role: 'user', created: T + 1_000 },
      { id: bravo, role: 'user', created: T + 1_200 },
      { id: merged, role: 'assistant', parentID: bravo, created: T + 2_600, completed: T + 3_500 },
    ];
    const { deps, calls } = fakeDeps({ open: [turn(alpha), turn(bravo)], tip });
    const out = await reconcileForwardedTurnsAtEnd(
      { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: bravo },
      deps,
    );
    expect(out).toEqual({ closedOlder: 1, candidates: 0, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
    expect(calls.closeOlder.map((c) => c[2])).toEqual([alpha]);
    expect(calls.remove).toHaveLength(0);
    expect(calls.requeue).toHaveLength(0);
  });

  test('a stranded newer prompt is removed, re-queued, its turn closed, and the drain kicked', async () => {
    // A strand is an id/time DISAGREEMENT: u4's id (minted from a stale tip
    // read) sorts below aM, and the box persisted u4 (T+3200) after aM's
    // step began (T+3000). The step never read it.
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user', created: T + 3_200 },
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd({ sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M }, deps);
    expect(out).toEqual({ closedOlder: 0, candidates: 1, stranded: 1, orphaned: 0, requeued: 1, reordered: 0, closedRead: 0 });
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
    expect(out).toEqual({ closedOlder: 0, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
    expect(calls.remove).toHaveLength(0);
    expect(calls.closeStranded).toHaveLength(0);
  });

  // Live incident 2026-09-21/22 (three of three steer runs; sessions 4f345186,
  // 17e3ad83, f0e9b423, 1548cb84): three Quick Queue prompts steered ~1 s
  // apart into a tool turn A. P (the second) went out LIFTED to the box clock;
  // S (the third) went out UNDER-PLACED at its client id, below P. OpenCode
  // parented the one merged reply on S (newest by `time.created`) and the
  // relay named S as the ended message. P was the only open row with an id
  // ABOVE S, so it was a "newer" candidate; by id order the merged reply is a
  // higher assistant parented on an older user — the strand signature — and
  // P was deleted from the transcript, re-queued (`redeliveries = 1`), its
  // ledger row closed `abandoned`, and the model answered it a second, paid
  // time. The box's stamps had the proof all along: the reply's step began
  // AFTER P was persisted, so P was in its input.
  describe('a newer candidate the ended step READ (merged reply parented on an under-placed later sibling)', () => {
    const A = id(T, 'TOOLATOOLATOOL'); // the tool prompt the turn started on
    const aA = id(T + 500, 'ASSTAASSTAASST'); // one of its tool-call steps
    const P = id(T + 2_000, 'LIFTDLIFTDLIFT'); // persisted T+1000, id lifted to the box clock
    const S = id(T + 1_500, 'UNDERUNDERUNDE'); // persisted T+1200 under its client id
    const merged = id(T + 3_000, 'MERGEMERGEMERG');
    const tip = (completed: number | null): PlacementTipMessage[] => [
      { id: A, role: 'user', created: T },
      { id: aA, role: 'assistant', parentID: A, created: T + 500, completed: T + 900 },
      { id: P, role: 'user', created: T + 1_000 },
      { id: S, role: 'user', created: T + 1_200 },
      { id: merged, role: 'assistant', parentID: S, created: T + 2_500, completed },
    ];

    test('closes completed and is never re-queued', async () => {
      const { deps, calls } = fakeDeps({ open: [turn(A), turn(P), turn(S)], tip: tip(T + 2_600) });
      const out = await reconcileForwardedTurnsAtEnd(
        { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: S },
        deps,
      );
      expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 1 });
      expect(calls.closeOlder.map((c) => c[2])).toEqual([A, P]);
      expect(calls.remove).toEqual([]);
      expect(calls.requeue).toEqual([]);
      expect(calls.closeStranded).toEqual([]);
      expect(calls.kick).toEqual([]);
    });

    test('three steers one drain apart (17e3ad83): the first closes older, the MIDDLE closes read, nothing re-queues', async () => {
      // Q1 went out at newest+1 (no box-clock sample yet) — below Q3 by id.
      // Q2 was lifted above everything. Q3 was under-placed at its client id
      // because Q2 sat open above it. One reply, parented on Q3, answered all
      // three; the relay named Q3.
      const Q1 = id(T + 1_100, 'QONE1QONE1QONE'); // persisted T+1000
      const Q2 = P; // lifted, persisted T+1000+...
      const Q3 = S;
      const tip3: PlacementTipMessage[] = [
        { id: A, role: 'user', created: T },
        { id: aA, role: 'assistant', parentID: A, created: T + 500, completed: T + 900 },
        { id: Q1, role: 'user', created: T + 950 },
        { id: Q2, role: 'user', created: T + 1_000 },
        { id: Q3, role: 'user', created: T + 1_200 },
        { id: merged, role: 'assistant', parentID: Q3, created: T + 2_500, completed: T + 2_600 },
      ];
      const { deps, calls } = fakeDeps({ open: [turn(A), turn(Q1), turn(Q2), turn(Q3)], tip: tip3 });
      const out = await reconcileForwardedTurnsAtEnd(
        { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: Q3 },
        deps,
      );
      expect(out).toEqual({ closedOlder: 2, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 1 });
      expect(calls.closeOlder.map((c) => c[2])).toEqual([A, Q1, Q2]);
      expect(calls.remove).toEqual([]);
      expect(calls.requeue).toEqual([]);
      expect(calls.closeStranded).toEqual([]);
    });

    test('read by a step still OPEN is left alone — that step\'s end closes it', async () => {
      const { deps, calls } = fakeDeps({ open: [turn(A), turn(P), turn(S)], tip: tip(null) });
      const out = await reconcileForwardedTurnsAtEnd(
        { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: S },
        deps,
      );
      expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
      expect(calls.closeOlder.map((c) => c[2])).toEqual([A]);
      expect(calls.remove).toEqual([]);
      expect(calls.requeue).toEqual([]);
      expect(calls.closeStranded).toEqual([]);
    });

    // The tip read is the newest 12 messages. A genuine strand always sits at
    // the tip (the loop exits right after the step that missed it), but a
    // READ candidate can be arbitrarily deep: the tool work went on for a
    // dozen steps after the merged reply's step began, one assistant message
    // each, all parented on S. P is then off the tip, its `time.created` with
    // it — and with no stamp to read, the id-order rule calls it stranded
    // again: every step assistant has a higher id and a parent below P.
    describe('the read candidate is OFF the tip after a long tool loop', () => {
      const steps: PlacementTipMessage[] = Array.from({ length: 12 }, (_, i) => ({
        id: id(T + 3_000 + i * 100, `STEP${String(i).padStart(2, '0')}STEP${String(i).padStart(2, '0')}ST`),
        role: 'assistant',
        parentID: S,
        created: T + 2_500 + i * 100,
        completed: T + 2_550 + i * 100,
      }));
      const deepTip: PlacementTipMessage[] = [{ id: S, role: 'user', created: T + 1_200 }, ...steps];

      test('its message is fetched by id, its stamp read, and it closes completed — never re-queued', async () => {
        const { deps, calls } = fakeDeps({
          open: [turn(A), turn(P), turn(S)],
          tip: deepTip,
          readMessage: async (_sessionId, messageId) =>
            messageId === P ? { id: P, role: 'user', created: T + 1_000 } : null,
        });
        const out = await reconcileForwardedTurnsAtEnd(
          { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: S },
          deps,
        );
        expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 1 });
        expect(calls.closeOlder.map((c) => c[2])).toEqual([A, P]);
        expect(calls.remove).toEqual([]);
        expect(calls.requeue).toEqual([]);
        expect(calls.closeStranded).toEqual([]);
      });

      test('when its message cannot be fetched it is left to the reaper — id order alone never strands it', async () => {
        const { deps, calls } = fakeDeps({ open: [turn(A), turn(P), turn(S)], tip: deepTip });
        const out = await reconcileForwardedTurnsAtEnd(
          { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: S },
          deps,
        );
        expect(calls.readMessage).toEqual([['s', P]]);
        expect(out).toEqual({ closedOlder: 1, candidates: 1, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
        expect(calls.remove).toEqual([]);
        expect(calls.requeue).toEqual([]);
        expect(calls.closeStranded).toEqual([]);
      });

      test('a candidate ON the tip is never fetched', async () => {
        const { deps, calls } = fakeDeps({ open: [turn(A), turn(P), turn(S)], tip: tip(T + 2_600) });
        await reconcileForwardedTurnsAtEnd(
          { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: S },
          deps,
        );
        expect(calls.readMessage).toEqual([]);
      });
    });
  });

  // EXPECTATION FLIPPED 2026-08-20 (live incident, SampleCo session
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
    const tip = tipOf([{ id: M, role: 'user' }, { id: u4, role: 'user', created: T + 3_200 }, { id: aM, role: 'assistant', parentID: M }]);
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
      { id: u4, role: 'user', created: T + 3_200 }, // persisted after aM's step began
      { id: aM, role: 'assistant', parentID: M, completed: T + 3_500 },
      { id: u5, role: 'user' },
    ]);
    const { deps, calls } = fakeDeps({ open: [turn(u4, 'delivering'), turn(u5, 'delivering')], tip });
    const out = await reconcileForwardedTurnsAtEnd(
      { sessionId: 's', opencodeSessionId: 'ses_root', endedMessageId: M },
      deps,
    );
    expect(out).toEqual({ closedOlder: 0, candidates: 2, stranded: 1, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 });
    expect(calls.remove).toHaveLength(0);
    expect(calls.requeue).toHaveLength(0);
  });

  test('a fully stranded TAIL re-queues as a whole, so the batch re-mints it in order', async () => {
    // Both u4 and u5 are stranded below aM — the loop exited without either.
    // Both come back; the drain's batch re-mints them by send order.
    const u5b = id(T + 2_600, 'USER5BUSER5BUS');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user', created: T + 3_200 }, // both persisted after aM's step began
      { id: u5b, role: 'user', created: T + 3_300 },
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
    // u4 is stranded by BOTH steps: persisted (T+4200) after aM's step began
    // (T+3000) and after a5's step began (T+4100). Nothing has read it.
    const a5 = id(T + 4_100, 'ASST5ASST5ASST');
    const tip = tipOf([
      { id: M, role: 'user' },
      { id: u4, role: 'user', created: T + 4_200 },
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
