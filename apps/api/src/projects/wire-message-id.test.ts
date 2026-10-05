import { describe, expect, test } from 'bun:test';
import vectors from '../../../../tests/spec/wire-message-id.vectors.json';
import {
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  maxWireIdClock,
  mintWireMessageId,
  newestWireIdTime,
  wireIdClockDelta,
  wireIdTime,
} from './wire-message-id';

describe('wireIdTime', () => {
  test('decodes the ordering clock out of a wire id', () => {
    expect(wireIdTime('msg_8bbf25e40000AbCdEfGhIjKlMn')).toBe(BigInt('0x8bbf25e40000'));
  });

  test('a shape it cannot order is null, never a guess', () => {
    expect(wireIdTime('cm_12')).toBeNull();
    expect(wireIdTime('msg_ZZZZZZZZZZZZaaaaaaaaaaaaaa')).toBeNull();
    expect(wireIdTime('')).toBeNull();
  });
});

describe('mintWireMessageId — golden vectors shared with @kortix/sdk', () => {
  // Runs the fixture through the API's names: proves each alias in
  // `wire-message-id.ts` maps to the SDK function with the matching contract.
  for (const vector of vectors.vectors) {
    test(vector.name, () => {
      const minted = mintWireMessageId({
        nowMs: vector.nowMs,
        newestKnownTime:
          vector.newestKnownTime === null ? null : BigInt(`0x${vector.newestKnownTime}`),
        random: () => 0,
      });
      expect(minted.time.toString(16).padStart(12, '0')).toBe(vector.expectedTime);
      expect(minted.id.slice(4, 16)).toBe(vector.expectedTime);
    });
  }
});

describe('newestWireIdTime — golden vectors shared with @kortix/sdk', () => {
  for (const vector of vectors.newest) {
    test(vector.name, () => {
      const newest = newestWireIdTime(vector.ids, vector.nowMs ?? undefined);
      expect(newest === null ? null : newest.toString(16).padStart(12, '0')).toBe(vector.expected);
    });
  }
});

describe('wireIdClockDelta / maxWireIdClock — golden vectors shared with @kortix/sdk', () => {
  for (const vector of vectors.delta) {
    test(vector.name, () => {
      const clock = BigInt(`0x${vector.clock}`);
      const reference = BigInt(`0x${vector.reference}`);
      expect(wireIdClockDelta(clock, reference)).toBe(BigInt(vector.expected));
      const newest = maxWireIdClock([clock, reference]);
      expect(newest).toBe(BigInt(vector.expected) >= BigInt(0) ? clock : reference);
    });
  }
});

describe('mintWireMessageId', () => {
  test('mints the format OpenCode accepts', () => {
    const minted = mintWireMessageId({ nowMs: 1755500000000 });
    expect(minted.id).toMatch(WIRE_MESSAGE_ID);
  });

  test('a re-mint against a known newest id always sorts strictly after it', () => {
    // The one property the redelivery path depends on: a re-minted prompt must
    // land BELOW nothing already in the transcript, or OpenCode reads it as
    // already answered and the redelivered turn never runs. Holds for every
    // newest id inside the correction bound — measured from the BACKDATED
    // clock, so the last offset that still lifts is 3600s - 120s of skew.
    const nowMs = 1755500000000;
    for (const offsetMs of [-86_400_000, -1_000, 0, 1_000, 60_000, 3_480_000]) {
      const newest = (BigInt(nowMs + offsetMs) * BigInt(0x1000)) & BigInt(0xffffffffffff);
      const minted = mintWireMessageId({ nowMs, newestKnownTime: newest, random: () => 0 });
      expect(minted.time > newest).toBe(true);
    }
  });

  test('an absurd newest id does not drag the mint into the far future', () => {
    const nowMs = 1755500000000;
    const absurd = (BigInt(nowMs + 30 * 24 * 60 * 60_000) * BigInt(0x1000)) & BigInt(0xffffffffffff);
    const minted = mintWireMessageId({ nowMs, newestKnownTime: absurd, random: () => 0 });
    expect(minted.time < absurd).toBe(true);
  });

  test('the random tail is 14 base62 chars and varies', () => {
    const a = mintWireMessageId({ nowMs: 1755500000000 });
    const b = mintWireMessageId({ nowMs: 1755500000000 });
    expect(a.id).toHaveLength(4 + 12 + 14);
    expect(a.id.slice(16)).not.toBe(b.id.slice(16));
  });
});

/**
 * `kortix sessions send` minted the HIGH 12 hex digits of `Date.now()*0x1000`
 * from 2026-08-22 until this fix: `msg_1a0d…` where OpenCode writes `msg_0d4…`,
 * ~40 days ahead of every real id. Such an id cannot have been placed against
 * any transcript, so no floor, lift, or kept-as-is decision may trust it.
 */
describe('far-future ids (the pre-fix CLI shape)', () => {
  const nowMs = Date.parse('2026-09-24T16:30:00.000Z');
  const cliId = 'msg_1a0d42f86f80SyntheticCli03';
  const opencodeId = 'msg_0d43ff670001SyntheticRep04';

  test('isWireIdAheadOf flags the CLI id and accepts real ids on both sides of the wrap', () => {
    expect(isWireIdAheadOf(cliId, nowMs)).toBe(true);
    expect(isWireIdAheadOf(opencodeId, nowMs)).toBe(false);
    expect(isWireIdAheadOf('msg_ffcb5ca00001aaaaaaaaaaaaaa', nowMs)).toBe(false);
    expect(isWireIdAheadOf(mintWireMessageId({ nowMs: nowMs + 10 * 60_000 }).id, nowMs)).toBe(false);
  });

  test('newestWireIdTime skips an id more than an hour ahead of now', () => {
    expect(newestWireIdTime([opencodeId, cliId], nowMs)).toBe(wireIdTime(opencodeId));
  });
});
