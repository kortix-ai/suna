import { describe, expect, test } from 'bun:test';
import vectors from '../../../../tests/spec/wire-message-id.vectors.json';
import { WIRE_MESSAGE_ID, mintWireMessageId, wireIdTime } from './wire-message-id';

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
  // The SDK asserts the SAME file. apps/api cannot import the SDK's minter
  // (no dependency, and it reads the browser sync store), so the fixture is
  // what stops the two implementations drifting apart.
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
