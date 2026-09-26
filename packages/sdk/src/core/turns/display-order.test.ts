import { describe, expect, test } from 'bun:test';
import { compareMessagesForDisplay, groupMessagesIntoTurns } from './grouping';
import type { MessageWithPartsLike } from './types';

/**
 * Display order has to be a TOTAL order, and it was not one.
 *
 * The comparator applied two different orderings depending on which pair it
 * was handed: wire-id order when BOTH ids were well-formed wire ids, and
 * `time.created` order for every pair involving anything else. A queued row
 * carries a host-fabricated timestamp, so a transcript of two real messages
 * plus one queued row produced a CYCLE:
 *
 *   A vs B  → by id   → A < B
 *   S vs A  → by time → S < A
 *   B vs S  → by time → B > S      ⇒  S < A < B < S
 *
 * `Array.prototype.sort` with a cyclic comparator is free to emit any
 * permutation, and V8 changes algorithm with input length — which is exactly
 * the reported bug: three prompts sent "who", "are", "you" rendered as
 * "who", "you", "are". The same bad sort feeds `groupMessagesIntoTurns`,
 * whose sequential fallback walks the sorted list, so assistant replies also
 * attached to the wrong user turns.
 *
 * The model that fixes it, from the comparator's own documented principle
 * ("for wire ids, id order IS conversation order; `time.created` is NOT"):
 *
 *   1. Everything the server has PLACED (it has a wire id) comes first, in
 *      wire-id order.
 *   2. Everything that is still only LOCAL — an optimistic stub, a queued
 *      inbox row the transcript has not echoed — comes after all of it, in
 *      the order the user actually sent it, untimed last.
 *
 * Two disjoint segments, each internally a total order. No fabricated
 * timestamps anywhere, so no clock skew can reorder a conversation.
 */

const wire = (id: string, created?: number): MessageWithPartsLike =>
  ({
    info: { id, role: 'user', ...(created === undefined ? {} : { time: { created } }) },
    parts: [],
  }) as unknown as MessageWithPartsLike;

const local = (id: string, created?: number): MessageWithPartsLike =>
  ({
    info: { id, role: 'user', ...(created === undefined ? {} : { time: { created } }) },
    parts: [],
  }) as unknown as MessageWithPartsLike;

const A = wire('msg_0219ed624000', 5_000);
const B = wire('msg_0219ed624001', 5_001);
const S = local('queued-9f1c2a44-1111-2222-3333-444455556666', 4_000);

/** Every ordering of `items`, so a comparator can be checked for consistency. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

describe('compareMessagesForDisplay is a total order', () => {
  test('the reported cycle is gone', () => {
    // The three comparisons that used to disagree with each other.
    expect(compareMessagesForDisplay(A, B)).toBeLessThan(0);
    // S is LOCAL, so it follows the transcript no matter what its clock says.
    expect(compareMessagesForDisplay(S, A)).toBeGreaterThan(0);
    expect(compareMessagesForDisplay(B, S)).toBeLessThan(0);
  });

  test('is antisymmetric and transitive over the reported triple', () => {
    const items = [A, B, S];
    // Compare SIGNS: the contract is the direction, not the magnitude, and
    // `Object.is(0, -0)` is false so a raw negation trips on x === x.
    for (const x of items) {
      for (const y of items) {
        // `|| 0` normalises the -0 that negating a zero sign produces.
        expect(Math.sign(compareMessagesForDisplay(x, y)) || 0).toBe(
          -Math.sign(compareMessagesForDisplay(y, x)) || 0,
        );
      }
    }
    for (const x of items) {
      for (const y of items) {
        for (const z of items) {
          if (compareMessagesForDisplay(x, y) < 0 && compareMessagesForDisplay(y, z) < 0) {
            expect(compareMessagesForDisplay(x, z)).toBeLessThan(0);
          }
        }
      }
    }
  });

  test('every input permutation sorts to the SAME output', () => {
    // The property that a cyclic comparator cannot have, and the one the user
    // actually observes: the transcript must not depend on arrival order.
    const expected = ['msg_0219ed624000', 'msg_0219ed624001', S.info.id];
    for (const perm of permutations([A, B, S])) {
      const sorted = [...perm].sort(compareMessagesForDisplay).map((m) => m.info.id);
      expect(sorted).toEqual(expected);
    }
  });
});

describe('queued prompts hold the order the user sent them in', () => {
  test('"who", "are", "you" render in that order whatever the server list says', () => {
    // Three rapid sends race as three concurrent POSTs, so the server's own
    // `created_at` order (its insert order) is the network's, not the user's.
    // The send instant is the only record of what the user did.
    const who = local('queued-who', 1_000);
    const are = local('queued-are', 1_001);
    const you = local('queued-you', 1_002);

    // Handed over in the WRONG order, as the racing POSTs actually list them.
    const sorted = [you, who, are].sort(compareMessagesForDisplay).map((m) => m.info.id);

    expect(sorted).toEqual(['queued-who', 'queued-are', 'queued-you']);
  });

  test('a queued row never sorts above the transcript, whatever its clock says', () => {
    // The box stamps real messages from its own clock and can run ahead of the
    // browser (~1s measured). A queued row stamped by the tab used to sort
    // ABOVE the previous turn, which is what mis-paired the assistant replies.
    const stale = local('queued-late', 1);
    const sorted = [stale, A, B].sort(compareMessagesForDisplay).map((m) => m.info.id);

    expect(sorted).toEqual(['msg_0219ed624000', 'msg_0219ed624001', 'queued-late']);
  });

  test('an untimed local stub still sorts last among locals', () => {
    // `beginOptimisticSend` deliberately writes no `time.created` — see
    // use-session-send. It is the newest thing the user did.
    const timed = local('queued-timed', 9_000);
    const untimed = local('stub-no-clock');
    const sorted = [untimed, timed].sort(compareMessagesForDisplay).map((m) => m.info.id);

    expect(sorted).toEqual(['queued-timed', 'stub-no-clock']);
  });
});

describe('grouping follows the fixed order', () => {
  test('assistant replies stay with the user message that produced them', () => {
    // The sequential fallback walks the SORTED list, so a bad sort re-parents
    // every assistant message that carries no `parentID` — the second
    // screenshot, where "as" was answered by "yo".
    // Untimed on purpose: an id is ordered by the clock it encodes, checked
    // against `time.created`, and `created: 5_000` next to an id encoding ~6.5
    // days is a pairing no runtime writes. This test is about the id sequence.
    const messages = [
      wire('msg_0219ed624000'),
      { info: { id: 'msg_0219ed624001', role: 'assistant' }, parts: [] },
      wire('msg_0219ed624002'),
      { info: { id: 'msg_0219ed624003', role: 'assistant' }, parts: [] },
      local('queued-next', 1),
    ] as unknown as MessageWithPartsLike[];

    const turns = groupMessagesIntoTurns(messages);

    expect(turns.map((t) => t.userMessage.info.id)).toEqual([
      'msg_0219ed624000',
      'msg_0219ed624002',
      'queued-next',
    ]);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['msg_0219ed624001']);
    expect(turns[1].assistantMessages.map((m) => m.info.id)).toEqual(['msg_0219ed624003']);
    expect(turns[2].assistantMessages).toEqual([]);
  });
});

describe('durable queue display order', () => {
  test('client wire IDs remain after delivered turns until the inbox releases them', () => {
    const message = (id: string, role = 'user', parentID?: string) => ({
      info: { id, role, parentID, time: { created: 1 } }, parts: [],
    });
    const waitingA = message('msg_000000000002queued');
    const waitingB = message('msg_000000000003queued');
    const delivered = message('msg_000000000010delivered');
    const reply = message('msg_000000000011reply', 'assistant', delivered.info.id);
    const pendingMessageIds = new Set([waitingA.info.id, waitingB.info.id]);
    for (const input of permutations([waitingA, waitingB, delivered, reply])) {
      const turns = groupMessagesIntoTurns(input, { pendingMessageIds });
      expect(turns.map((turn) => turn.userMessage.info.id)).toEqual([
        delivered.info.id, waitingA.info.id, waitingB.info.id,
      ]);
      expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual([reply.info.id]);
    }
  });
});

/**
 * A wire id is a POSITION only while it agrees with the clock it encodes.
 *
 * `kortix sessions send` minted `msg_` + the HIGH 12 hex digits of
 * `Date.now() * 0x1000` from 2026-08-22 until this fix. OpenCode keeps the LOW
 * 48 bits, so every CLI prompt landed ~40 days ahead of every id OpenCode
 * minted itself (`msg_1a0d…` against `msg_0d4…`). Ordered by raw id, a later
 * prompt sent from the web (`msg_0d43…`) rendered its whole turn ABOVE those
 * CLI prompts, and the last turn on screen was an older, finished one with a
 * "Thinking" row under it while the real work streamed out of view.
 *
 * The same raw-id order also breaks on the id clock's 48-bit wrap
 * (2026-08-14 11:19:55 UTC): `msg_ffcb…` from the day before sorted below
 * `msg_0002…` from the day after.
 *
 * Fixtures are synthetic, in the shape a prod transcript had: CLI ids ~40
 * days ahead, web and OpenCode ids within two minutes of their timestamps.
 */
describe('placed ids that disagree with their own timestamp', () => {
  const at = (iso: string) => Date.parse(iso);
  const user = (id: string, iso: string): MessageWithPartsLike =>
    ({ info: { id, role: 'user', time: { created: at(iso) } }, parts: [] }) as unknown as MessageWithPartsLike;
  const reply = (id: string, parentID: string, iso: string): MessageWithPartsLike =>
    ({
      info: { id, role: 'assistant', parentID, time: { created: at(iso) } },
      parts: [],
    }) as unknown as MessageWithPartsLike;

  const u1 = user('msg_0b606027c000SyntheticUser1', '2026-09-18T19:40:00.061Z');
  const a1 = reply('msg_0b6086abd001aaaaaaaaaaaaaa', u1.info.id, '2026-09-18T19:40:01.000Z');
  // CLI-minted: high bits, ~40 days ahead of the clock they claim.
  const u2 = user('msg_1a0d3bfa6280SyntheticCli02', '2026-09-24T14:09:50.760Z');
  const a2 = reply('msg_0d3c0541d001SyntheticRep02', u2.info.id, '2026-09-24T14:09:52.000Z');
  const u3 = user('msg_1a0d42f86f80SyntheticCli03', '2026-09-24T16:11:24.000Z');
  const a3 = reply('msg_0d42f9e82001SyntheticRep03', u3.info.id, '2026-09-24T16:11:25.000Z');
  // Web-minted ("Update to latest"): a correct id, backdated 2 minutes.
  const u4 = user('msg_0d43d94e4000SyntheticWeb04', '2026-09-24T16:29:16.202Z');
  const a4 = reply('msg_0d43ff670001SyntheticRep04', u4.info.id, '2026-09-24T16:29:16.300Z');

  test('a CLI-minted far-future id no longer pushes later turns above it', () => {
    for (const input of permutations([u1, u2, u3, u4])) {
      const sorted = [...input].sort(compareMessagesForDisplay).map((m) => m.info.id);
      expect(sorted).toEqual([u1.info.id, u2.info.id, u3.info.id, u4.info.id]);
    }
  });

  test('the newest turn is the last turn, with its own replies', () => {
    const turns = groupMessagesIntoTurns([a4, u3, a1, u4, u2, a3, u1, a2]);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual([
      u1.info.id,
      u2.info.id,
      u3.info.id,
      u4.info.id,
    ]);
    expect(turns[3].assistantMessages.map((m) => m.info.id)).toEqual([a4.info.id]);
    expect(turns[2].assistantMessages.map((m) => m.info.id)).toEqual([a3.info.id]);
  });

  test('a session that spans the 2026-08-14 id-clock wrap stays in time order', () => {
    const before = user('msg_ffcb5ca00001aaaaaaaaaaaaaa', '2026-08-13T20:00:00.000Z');
    const after = user('msg_00024b200001bbbbbbbbbbbbbb', '2026-08-14T12:00:00.000Z');
    expect([after, before].sort(compareMessagesForDisplay).map((m) => m.info.id)).toEqual([
      before.info.id,
      after.info.id,
    ]);
  });

  test('ids that agree with their clock still win over arrival order', () => {
    // The reason ids order the transcript at all: concurrent queued POSTs
    // persist in network order. Ids placed 1 ms apart, persisted 2 s apart in
    // the OTHER order, must keep id order.
    const first = user('msg_0d43d94e4001aaaaaaaaaaaaaa', '2026-09-24T16:29:18.000Z');
    const second = user('msg_0d43d94e4002bbbbbbbbbbbbbb', '2026-09-24T16:29:16.000Z');
    expect([second, first].sort(compareMessagesForDisplay).map((m) => m.info.id)).toEqual([
      first.info.id,
      second.info.id,
    ]);
  });
});
