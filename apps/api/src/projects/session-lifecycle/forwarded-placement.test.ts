import { afterEach, describe, expect, test } from 'bun:test';
import {
  boxClockSkewMs,
  reachedPlacement,
  tipIsBusy,
  mintLivePlacement,
  noteBoxClockSample,
  parsePlacementTip,
  resetBoxClockSkewForTests,
  strandedPlacement,
} from './forwarded-placement';
import { WIRE_ID_TIME_SCALE, wireIdTime } from '../wire-message-id';

/** An id whose clock is `ms` (box clock) and counter `n`. */
const id = (ms: number, n = 1, tail = 'AAAAAAAAAAAAAA') =>
  `msg_${((BigInt(ms) * WIRE_ID_TIME_SCALE + BigInt(n)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0')}${tail}`;

const T = 1_800_000_000_000;

describe('strandedPlacement', () => {
  const user1 = id(T, 1, 'USER1USER1USER');
  const asst1 = id(T + 10, 1, 'ASST1ASST1ASST');
  const user2 = id(T + 20, 1, 'USER2USER2USER');

  test('answered when an assistant is parented on the wire id', () => {
    const v = strandedPlacement(
      [
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: user2, role: 'user', created: T + 20 },
        { id: id(T + 30, 1, 'ASST2ASST2ASST'), role: 'assistant', parentID: user2 },
      ],
      user2,
    );
    expect(v.answered).toBe(true);
    expect(v.stranded).toBe(false);
    expect(v.createdMs).toBe(T + 20);
  });

  test('stranded: a higher assistant whose parent is an OLDER user message', () => {
    // user2 was inserted at T+20 with an id below asst2 (created T+25 by a
    // step that read the transcript before user2 existed).
    const asst2 = id(T + 25, 1, 'ASST2ASST2ASST');
    const v = strandedPlacement(
      [
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: id(T + 22, 1, 'LATEUSERLATEUS'), role: 'user' },
        { id: asst2, role: 'assistant', parentID: user1 },
      ],
      id(T + 22, 1, 'LATEUSERLATEUS'),
    );
    expect(v.stranded).toBe(true);
    expect(v.strandedBy).toBe(asst2);
    expect(v.newest).toBe(wireIdTime(asst2));
  });

  test('not stranded: the higher assistant is parented on a NEWER user message (answered in that step)', () => {
    // OpenCode parents the step on the newest user message and answers every
    // queued one before it in the same step.
    const user3 = id(T + 40, 1, 'USER3USER3USER');
    const asst3 = id(T + 41, 1, 'ASST3ASST3ASST');
    const v = strandedPlacement(
      [
        { id: user2, role: 'user' },
        { id: user3, role: 'user' },
        { id: asst3, role: 'assistant', parentID: user3 },
      ],
      user2,
    );
    expect(v.stranded).toBe(false);
    expect(v.answered).toBe(false);
  });

  test('not reached yet: no assistant above it', () => {
    const v = strandedPlacement(
      [
        { id: user1, role: 'user' },
        { id: asst1, role: 'assistant', parentID: user1 },
        { id: user2, role: 'user' },
      ],
      user2,
    );
    expect(v.stranded).toBe(false);
    expect(v.answered).toBe(false);
  });

  test('an assistant with no parent proves nothing', () => {
    const v = strandedPlacement(
      [
        { id: user2, role: 'user' },
        { id: id(T + 30, 1, 'ORPHANORPHANOR'), role: 'assistant' },
      ],
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
    expect(reachedPlacement([{ id: u1, role: 'user' }, { id: a1, role: 'assistant', parentID: u1 }, { id: u2, role: 'user' }], u2)).toBe(false);
  });
  test('reached via a step parented on a newer user message', () => {
    expect(reachedPlacement([{ id: u2, role: 'user' }, { id: u3, role: 'user' }, { id: a3, role: 'assistant', parentID: u3 }], u2)).toBe(true);
  });
  test('a stranded message is NOT reached (higher assistant, older parent)', () => {
    expect(reachedPlacement([{ id: u1, role: 'user' }, { id: u2, role: 'user' }, { id: id(T + 25, 1, 'ASSTXASSTXASST'), role: 'assistant', parentID: u1 }], u2)).toBe(false);
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
    expect(tipIsBusy([{ id: a1, role: 'assistant', parentID: u1, completed: null }])).toBe(true);
    expect(tipIsBusy([{ id: a1, role: 'assistant', parentID: u1, completed: 5 }])).toBe(false);
    expect(tipIsBusy([{ id: u1, role: 'user' }])).toBe(false);
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
