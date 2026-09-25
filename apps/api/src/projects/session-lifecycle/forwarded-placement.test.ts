import { afterEach, describe, expect, test } from 'bun:test';
import {
  type PlacementTipMessage,
  boxClockSkewMs,
  isLaterTipMessage,
  reachedPlacement,
  tipIsBusy,
  mintLivePlacement,
  noteBoxClockSample,
  openUserAbove,
  openUsersAbove,
  parsePlacementTip,
  promptAnsweredOnTip,
  resetBoxClockSkewForTests,
  strandedPlacement,
} from './forwarded-placement';
import { WIRE_ID_TIME_SCALE, wireIdTime } from '../wire-message-id';

/** An id whose clock is `ms` (box clock) and counter `n`. */
const id = (ms: number, n = 1, tail = 'AAAAAAAAAAAAAA') =>
  `msg_${((BigInt(ms) * WIRE_ID_TIME_SCALE + BigInt(n)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0')}${tail}`;

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

describe('strandedPlacement', () => {
  const user1 = id(T, 1, 'USER1USER1USER');
  const asst1 = id(T + 10, 1, 'ASST1ASST1ASST');
  const user2 = id(T + 20, 1, 'USER2USER2USER');

  test('answered when an assistant is parented on the wire id', () => {
    const v = strandedPlacement(
      tipOf([
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: user2, role: 'user', created: T + 20 },
        { id: id(T + 30, 1, 'ASST2ASST2ASST'), role: 'assistant', parentID: user2 },
      ]),
      user2,
    );
    expect(v.answered).toBe(true);
    expect(v.stranded).toBe(false);
    expect(v.createdMs).toBe(T + 20);
  });

  test('stranded: a higher assistant whose parent is an OLDER user message', () => {
    // The late user message got an id below asst2 (its POST was minted at
    // T+22 from a stale tip read) but was PERSISTED at T+27 — after asst2's
    // step began at T+25, when the step read the transcript. The stamps say
    // the step never saw it; that is the strand.
    const asst2 = id(T + 25, 1, 'ASST2ASST2ASST');
    const v = strandedPlacement(
      tipOf([
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: id(T + 22, 1, 'LATEUSERLATEUS'), role: 'user', created: T + 27 },
        { id: asst2, role: 'assistant', parentID: user1, created: T + 25 },
      ]),
      id(T + 22, 1, 'LATEUSERLATEUS'),
    );
    expect(v.stranded).toBe(true);
    expect(v.strandedBy).toBe(asst2);
    expect(v.readBy).toBeNull();
    expect(v.newest).toBe(wireIdTime(asst2));
  });

  // Live incident 2026-09-21/22 (sessions 17e3ad83, 4f345186, f0e9b423, three
  // of three steer runs): three Quick Queue prompts steered ~1 s apart into a
  // tool turn. The second one was LIFTED to the box clock (id above every
  // sibling); the third was UNDER-PLACED at its client id, below it. OpenCode
  // parented the one merged reply on the third (newest by `time.created`),
  // so by ID ORDER the reply has a higher id than the lifted prompt and a
  // parent that sorts below it — the strand signature — while the box's own
  // stamps say the step began AFTER the lifted prompt was persisted, i.e. it
  // was in that step's input and the reply answered it. Read as stranded, it
  // was deleted, re-queued and answered a second, paid time.
  describe('the merged reply of a later UNDER-PLACED sibling', () => {
    const lifted = id(T + 2_000, 1, 'LIFTDLIFTDLIFT'); // persisted T+1000, id lifted 1 s
    const under = id(T + 1_500, 1, 'UNDERUNDERUNDE'); // persisted T+1200 under its client id
    const merged = id(T + 3_000, 1, 'MERGEMERGEMERG');
    const tip = (completed: number | null): PlacementTipMessage[] => [
      { id: lifted, role: 'user', created: T + 1_000 },
      { id: under, role: 'user', created: T + 1_200 },
      { id: merged, role: 'assistant', parentID: under, created: T + 2_500, completed },
    ];

    test('read this prompt — not a strand; the reply is its reader', () => {
      const v = strandedPlacement(tip(T + 2_600), lifted);
      expect(v.answered).toBe(false);
      expect(v.stranded).toBe(false);
      expect(v.strandedBy).toBeNull();
      expect(v.readBy).toBe(merged);
      expect(v.readCompleted).toBe(true);
    });

    test('a reader still open is named, but not completed', () => {
      const v = strandedPlacement(tip(null), lifted);
      expect(v.stranded).toBe(false);
      expect(v.readBy).toBe(merged);
      expect(v.readCompleted).toBe(false);
    });

    // A completed merged reply is final even when a NEWER turn is already
    // running: the user sent U after the reply landed, and C (open, parented
    // on U) is a different turn. Judging only the newest reader answered
    // "not yet" here, which let a reaper re-queue of the prompt run it a
    // second time while C was open.
    test('a completed reader is final even when a NEWER turn is open — its own turn ended', () => {
      const later = id(T + 5_000, 1, 'LATERLATERLATE');
      const open = id(T + 6_000, 1, 'OPENAOPENAOPEN');
      const v = strandedPlacement(
        [
          ...tip(T + 2_600),
          { id: later, role: 'user', created: T + 5_000 },
          { id: open, role: 'assistant', parentID: later, created: T + 6_000, completed: null },
        ],
        lifted,
      );
      expect(v.stranded).toBe(false);
      expect(v.readBy).toBe(open);
      expect(v.readCompleted).toBe(true);
    });

    // The SAME turn, still running: its first step (a tool call) completed and
    // its next step is open, both parented on the same user. The reply that
    // answers this prompt is not final until that turn ends.
    test('a completed step of a turn that is STILL RUNNING is not final', () => {
      const next = id(T + 3_100, 1, 'NEXTSNEXTSNEXT');
      const v = strandedPlacement(
        [
          ...tip(T + 2_600),
          { id: next, role: 'assistant', parentID: under, created: T + 2_700, completed: null },
        ],
        lifted,
      );
      expect(v.stranded).toBe(false);
      expect(v.readBy).toBe(next);
      expect(v.readCompleted).toBe(false);
    });

    test('the same shape with DISAGREEING stamps is a genuine strand', () => {
      // The reply's step began (T+2500) before the lifted prompt was
      // persisted (T+2_700): it was not in the input.
      const v = strandedPlacement(
        [
          { id: lifted, role: 'user', created: T + 2_700 },
          { id: under, role: 'user', created: T + 1_200 },
          { id: merged, role: 'assistant', parentID: under, created: T + 2_500, completed: T + 2_600 },
        ],
        lifted,
      );
      expect(v.stranded).toBe(true);
      expect(v.strandedBy).toBe(merged);
      expect(v.readBy).toBeNull();
    });

    test('a missing stamp on either side keeps the id-order verdict', () => {
      const noOwnStamp = strandedPlacement(
        [
          { id: lifted, role: 'user' },
          { id: under, role: 'user', created: T + 1_200 },
          { id: merged, role: 'assistant', parentID: under, created: T + 2_500, completed: T + 2_600 },
        ],
        lifted,
      );
      expect(noOwnStamp.stranded).toBe(true);
      expect(noOwnStamp.readBy).toBeNull();
      const noReaderStamp = strandedPlacement(
        [
          { id: lifted, role: 'user', created: T + 1_000 },
          { id: under, role: 'user', created: T + 1_200 },
          { id: merged, role: 'assistant', parentID: under, completed: T + 2_600 },
        ],
        lifted,
      );
      expect(noReaderStamp.stranded).toBe(true);
      expect(noReaderStamp.readBy).toBeNull();
    });

    test('reachedPlacement agrees: the lifted prompt was reached', () => {
      expect(reachedPlacement(tip(T + 2_600), lifted)).toBe(true);
    });

    test('openUserAbove: a read user above is no longer OPEN', () => {
      // The lifted prompt sits above `under` by id, unanswered by parent link,
      // but a step has read it — nothing below it is covered by "its step".
      expect(openUserAbove(tip(T + 2_600), under)).toBe(false);
    });

    // Pins the `readBy` clause on its own: here the reader is parented on a
    // user ABOVE the lifted prompt by id, so id order never calls the lifted
    // prompt stranded — the only thing that closes it is the stamp proof.
    test('openUserAbove: a user above that a step read is not open, even when id order calls it in line', () => {
      const newer = id(T + 2_200, 1, 'NEWERNEWERNEWE');
      const reader = id(T + 3_000, 1, 'READRREADRREAD');
      const read: PlacementTipMessage[] = [
        { id: under, role: 'user', created: T + 1_200 },
        { id: lifted, role: 'user', created: T + 1_000 },
        { id: newer, role: 'user', created: T + 2_200 },
        { id: reader, role: 'assistant', parentID: newer, created: T + 2_500, completed: T + 2_600 },
      ];
      expect(strandedPlacement(read, lifted).stranded).toBe(false);
      expect(openUserAbove(read, under)).toBe(false);
      // The same shape with the step begun BEFORE the lifted prompt was
      // persisted: nothing has read it, so it is still open above `under`.
      const unread: PlacementTipMessage[] = [
        { id: under, role: 'user', created: T + 1_200 },
        { id: lifted, role: 'user', created: T + 2_800 },
        { id: newer, role: 'user', created: T + 2_200 },
        { id: reader, role: 'assistant', parentID: newer, created: T + 2_500, completed: T + 2_600 },
      ];
      expect(openUserAbove(unread, under)).toBe(true);
    });

    test('promptAnsweredOnTip: read by a COMPLETED step is answered', () => {
      expect(promptAnsweredOnTip(tip(T + 2_600), lifted)).toBe(true);
    });

    test('promptAnsweredOnTip: read by a step still OPEN is not yet answered', () => {
      expect(promptAnsweredOnTip(tip(null), lifted)).toBe(false);
    });

    test('promptAnsweredOnTip: a completed reader counts even when a newer turn is open', () => {
      const later = id(T + 5_000, 1, 'LATERLATERLATE');
      const open = id(T + 6_000, 1, 'OPENAOPENAOPEN');
      expect(
        promptAnsweredOnTip(
          [
            ...tip(T + 2_600),
            { id: later, role: 'user', created: T + 5_000 },
            { id: open, role: 'assistant', parentID: later, created: T + 6_000, completed: null },
          ],
          lifted,
        ),
      ).toBe(true);
    });

    // The ids behind the boolean. The drain's send-order gate (queued-continue.ts)
    // resolves each one to its inbox row: an open sibling above that was SENT
    // EARLIER than this prompt is a lifted id, not a later send, and this
    // prompt must not be placed under it (2026-09-22, sessions YO/134c0d27 on
    // the preview and 822e92a4 locally: ALPHA lifted, BRAVO under-placed
    // below it, rendered swapped).
    test('openUsersAbove names every OPEN user above the id; openUserAbove is its boolean', () => {
      const alsoOpen = id(T + 2_100, 1, 'ALSOOALSOOALSO');
      const twoOpen: PlacementTipMessage[] = [
        { id: under, role: 'user', created: T + 1_200 },
        { id: lifted, role: 'user', created: T + 1_000 },
        { id: alsoOpen, role: 'user', created: T + 1_300 },
      ];
      expect(openUsersAbove(twoOpen, under)).toEqual([lifted, alsoOpen]);
      expect(openUserAbove(twoOpen, under)).toBe(true);
      // A user a step has READ is not open — the same clause the boolean has.
      expect(openUsersAbove(tip(T + 2_600), under)).toEqual([]);
      expect(openUserAbove(tip(T + 2_600), under)).toBe(false);
      // Nothing above it: empty, never null.
      expect(openUsersAbove(tip(null), lifted)).toEqual([]);
      // The prompt's own id is never its own open sibling.
      expect(openUsersAbove([{ id: under, role: 'user', created: T + 1_200 }], under)).toEqual([]);
    });

    test('promptAnsweredOnTip: no stamps → the parent-only rule', () => {
      expect(
        promptAnsweredOnTip(
          [
            { id: lifted, role: 'user' },
            { id: under, role: 'user' },
            { id: merged, role: 'assistant', parentID: under, completed: T + 2_600 },
          ],
          lifted,
        ),
      ).toBe(false);
      expect(
        promptAnsweredOnTip(
          [
            { id: lifted, role: 'user' },
            { id: merged, role: 'assistant', parentID: lifted },
          ],
          lifted,
        ),
      ).toBe(true);
    });
  });

  test('not stranded: the higher assistant is parented on a NEWER user message (answered in that step)', () => {
    // OpenCode parents the step on the newest user message and answers every
    // queued one before it in the same step.
    const user3 = id(T + 40, 1, 'USER3USER3USER');
    const asst3 = id(T + 41, 1, 'ASST3ASST3ASST');
    const v = strandedPlacement(
      tipOf([
        { id: user2, role: 'user' },
        { id: user3, role: 'user' },
        { id: asst3, role: 'assistant', parentID: user3 },
      ]),
      user2,
    );
    expect(v.stranded).toBe(false);
    expect(v.answered).toBe(false);
  });

  test('not reached yet: no assistant above it', () => {
    const v = strandedPlacement(
      tipOf([
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: user2, role: 'user' },
      ]),
      user2,
    );
    expect(v.stranded).toBe(false);
    expect(v.answered).toBe(false);
  });

  test('an assistant with no parent proves nothing', () => {
    const v = strandedPlacement(
      tipOf([
        { id: user2, role: 'user' },
        { id: id(T + 30, 1, 'ORPHANORPHANOR'), role: 'assistant' },
      ]),
      user2,
    );
    expect(v.stranded).toBe(false);
  });
});

describe('reachedPlacement + tipIsBusy', () => {
  const u1 = id(T, 1, 'USER1USER1USER');
  const a1 = id(T + 10, 1, 'ASST1ASST1ASST');
  const u2 = id(T + 20, 1, 'USER2USER2USER');
  const u3 = id(T + 30, 1, 'USER3USER3USER');
  const a3 = id(T + 31, 1, 'ASST3ASST3ASST');
  test('unreached: nothing above it read it', () => {
    expect(reachedPlacement(tipOf([{ id: u1, role: 'user' }, { id: a1, role: 'assistant', parentID: u1 }, { id: u2, role: 'user' }]), u2)).toBe(false);
  });
  test('reached via a step parented on a newer user message', () => {
    expect(reachedPlacement(tipOf([{ id: u2, role: 'user' }, { id: u3, role: 'user' }, { id: a3, role: 'assistant', parentID: u3 }]), u2)).toBe(true);
  });
  test('a stranded message is NOT reached (higher assistant, older parent, step began first)', () => {
    // u2's id is below the assistant's, and the stamps agree that the step
    // began (T+25) before u2 was persisted (T+28): never read.
    expect(
      reachedPlacement(
        tipOf([
          { id: u1, role: 'user' },
          { id: u2, role: 'user', created: T + 28 },
          { id: id(T + 25, 1, 'ASSTXASSTXASST'), role: 'assistant', parentID: u1, created: T + 25 },
        ]),
        u2,
      ),
    ).toBe(false);
  });
  test('an assistant whose step STARTED before the message was persisted has not read it', () => {
    // Under-placement gives the message a LOW id on purpose; the running
    // step's assistant has a higher id and a parent >= it — but the box's
    // arrival stamps prove the step began first. Not reached → cancellable.
    const asst = id(T + 41, 1, 'ASSTRASSTRASST');
    const tip = [
      { id: u3, role: 'user', created: 500 },
      { id: u2, role: 'user', created: 900 }, // under-placed, arrived later
      { id: asst, role: 'assistant', parentID: u3, created: 600 },
    ];
    expect(reachedPlacement(tip, u2)).toBe(false);
    // Same shape, but the step began AFTER the message landed: reached.
    const tip2 = [
      { id: u3, role: 'user', created: 500 },
      { id: u2, role: 'user', created: 550 },
      { id: asst, role: 'assistant', parentID: u3, created: 600 },
    ];
    expect(reachedPlacement(tip2, u2)).toBe(true);
  });

  test('tipIsBusy reads the newest assistant', () => {
    expect(tipIsBusy(tipOf([{ id: a1, role: 'assistant', parentID: u1, completed: null }]))).toBe(true);
    expect(tipIsBusy(tipOf([{ id: a1, role: 'assistant', parentID: u1, completed: 5 }]))).toBe(false);
    expect(tipIsBusy(tipOf([{ id: u1, role: 'user' }]))).toBe(false);
  });

  // FAILS on the pre-2026-08-20 `m.id > newest.id` string compare. The two
  // assistants are ordered one way by id and the OTHER way by the box's own
  // `time.created` stamp — which is the order `MessageV2.page()` returns them
  // in, and the only order that is chronology.
  test('tipIsBusy picks the newest by time.created, not by id string order', () => {
    const lowIdLateStamp = id(T + 10, 1, 'ASSTLASSTLASST');
    const highIdEarlyStamp = id(T + 900, 1, 'ASSTHASSTHASST');
    const tip: PlacementTipMessage[] = [
      // Persisted SECOND (the box stamped it at T+950) but placed under a low
      // id — exactly what an under-placed / lifted mint produces.
      { id: lowIdLateStamp, role: 'assistant', parentID: u1, created: T + 950, completed: null },
      // Persisted FIRST and already finished, but carries the higher id.
      { id: highIdEarlyStamp, role: 'assistant', parentID: u1, created: T + 900, completed: T + 920 },
    ];
    // id order would pick `highIdEarlyStamp` (completed) -> "not busy".
    // time order picks `lowIdLateStamp` (still open) -> busy.
    expect(tipIsBusy(tip)).toBe(true);
  });
});

describe('isLaterTipMessage', () => {
  const older = id(T, 1, 'OLDEROLDEROLDE');
  const newer = id(T + 1_000, 1, 'NEWERNEWERNEWE');

  test('nothing is later than nothing', () => {
    expect(isLaterTipMessage({ id: older, role: 'user' }, null)).toBe(true);
    expect(isLaterTipMessage({ id: older, role: 'user' }, undefined)).toBe(true);
  });

  test('time.created decides, and it OUTRANKS the id clock', () => {
    // FAILS under any id-order comparison: `newer` sorts above `older` by id
    // but the box stamped it first.
    const a = { id: older, role: 'assistant', created: T + 5_000 };
    const b = { id: newer, role: 'assistant', created: T + 1_000 };
    expect(isLaterTipMessage(a, b)).toBe(true);
    expect(isLaterTipMessage(b, a)).toBe(false);
  });

  test("same millisecond falls back to the id clock — page()'s own tiebreak", () => {
    const a = { id: id(T, 2, 'SAMEMSAMEMSAME'), role: 'assistant', created: T };
    const b = { id: id(T, 1, 'SAMEMSAMEMSAMF'), role: 'assistant', created: T };
    expect(isLaterTipMessage(a, b)).toBe(true);
    expect(isLaterTipMessage(b, a)).toBe(false);
  });

  test('a missing or unusable stamp on either side falls back to the id clock', () => {
    expect(isLaterTipMessage({ id: newer, role: 'user' }, { id: older, role: 'user', created: T })).toBe(true);
    expect(isLaterTipMessage({ id: older, role: 'user', created: T }, { id: newer, role: 'user' })).toBe(false);
    expect(
      isLaterTipMessage(
        { id: newer, role: 'user', created: Number.NaN },
        { id: older, role: 'user', created: Number.NaN },
      ),
    ).toBe(true);
  });

  test('an id with no decodable clock falls back to the raw string, last', () => {
    expect(isLaterTipMessage({ id: 'msg_zz', role: 'user' }, { id: 'msg_aa', role: 'user' })).toBe(true);
    expect(isLaterTipMessage({ id: 'msg_aa', role: 'user' }, { id: 'msg_zz', role: 'user' })).toBe(false);
  });
});

describe('parsePlacementTip', () => {
  test('reads id, role, parentID and time.created', () => {
    expect(
      parsePlacementTip([
        { info: { id: 'msg_a', role: 'user', time: { created: 5 } } },
        { info: { id: 'msg_b', role: 'assistant', parentID: 'msg_a' } },
        { info: { role: 'assistant' } },
        null,
      ]),
    ).toEqual([
      { id: 'msg_a', role: 'user', parentID: null, created: 5, completed: null, partIds: [] },
      { id: 'msg_b', role: 'assistant', parentID: 'msg_a', created: null, completed: null, partIds: [] },
    ]);
    expect(parsePlacementTip({})).toBeNull();
  });
});

describe('box clock + live placement', () => {
  afterEach(() => resetBoxClockSkewForTests());

  test('skew is a lower bound (created − ack) and expires', () => {
    expect(noteBoxClockSample('s1', 1_000, 1_250, 10_000)).toBe(-250);
    expect(boxClockSkewMs('s1', 10_000)).toBe(-250);
    expect(boxClockSkewMs('s1', 10_000 + 3 * 60_000)).toBeNull();
  });

  test('no skew → the classic floor (newest+1, backdated clock)', () => {
    const newest = wireIdTime(id(T + 500));
    const m = mintLivePlacement({ nowMs: T + 600, newestKnownTime: newest, boxSkewMs: null, random: () => 0 });
    expect(m.lifted).toBe(false);
    expect(m.time).toBe(newest! + BigInt(1));
  });

  test('known skew lifts the id to the box clock now, above the floor', () => {
    const newest = wireIdTime(id(T + 500));
    const m = mintLivePlacement({ nowMs: T + 2_000, newestKnownTime: newest, boxSkewMs: -300, random: () => 0 });
    expect(m.lifted).toBe(true);
    expect(m.time).toBe((BigInt(T + 1_700) * WIRE_ID_TIME_SCALE) & BigInt(0xffffffffffff));
    expect(m.id).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
  });

  test('the lift never goes below the floor', () => {
    // The box wrote an id newer than our estimate of its clock.
    const newest = wireIdTime(id(T + 5_000));
    const m = mintLivePlacement({ nowMs: T + 2_000, newestKnownTime: newest, boxSkewMs: 0, random: () => 0 });
    expect(m.lifted).toBe(false);
    expect(m.time).toBe(newest! + BigInt(1));
  });

  test('an absurd skew is not trusted', () => {
    const newest = wireIdTime(id(T + 500));
    const m = mintLivePlacement({ nowMs: T + 2_000, newestKnownTime: newest, boxSkewMs: 5 * 60 * 60_000, random: () => 0 });
    expect(m.lifted).toBe(false);
  });
});
