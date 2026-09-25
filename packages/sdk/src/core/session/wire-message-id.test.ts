import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import wireIdVectors from '../../../../../tests/spec/wire-message-id.vectors.json';
import { mintWireMessageId as mintFromRoot } from '../../index';
import {
  WIRE_ID_CLOCK_TOLERANCE,
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  mintWireMessageId,
  maxWireIdClock,
  mintWireMessageIdAbove,
  newestWireIdClock,
  wireIdClock,
  wireIdClockAt,
  wireIdClockDelta,
} from './wire-message-id';

const clockHex = (id: string) => id.slice(4, 16);
const hex = (clock: bigint | null) => (clock === null ? null : clock.toString(16).padStart(12, '0'));

// The ONE place the golden vectors meet the implementation. apps/api and
// apps/mobile re-export this module and run the same file through their names.
describe('golden vectors — tests/spec/wire-message-id.vectors.json', () => {
  describe('mintWireMessageId (transcript ids in `after`)', () => {
    for (const vector of wireIdVectors.vectors) {
      test(vector.name, () => {
        const after = vector.newestKnownTime === null ? [] : [`msg_${vector.newestKnownTime}AAAAAAAAAAAAAA`];
        const id = mintWireMessageId({ nowMs: vector.nowMs, after });
        expect(id).toMatch(WIRE_MESSAGE_ID);
        expect(clockHex(id)).toBe(vector.expectedTime);
      });
    }
  });

  describe('mintWireMessageIdAbove (a floor clock)', () => {
    for (const vector of wireIdVectors.vectors) {
      test(vector.name, () => {
        const minted = mintWireMessageIdAbove({
          nowMs: vector.nowMs,
          newestKnownTime: vector.newestKnownTime === null ? null : BigInt(`0x${vector.newestKnownTime}`),
          random: () => 0,
        });
        expect(hex(minted.time)).toBe(vector.expectedTime);
        expect(minted.id).toBe(`msg_${vector.expectedTime}00000000000000`);
      });
    }
  });

  describe('newestWireIdClock', () => {
    for (const vector of wireIdVectors.newest) {
      test(vector.name, () => {
        expect(hex(newestWireIdClock(vector.ids, vector.nowMs ?? undefined))).toBe(vector.expected);
      });
    }
  });

  describe('maxWireIdClock (the same ids, decoded first)', () => {
    for (const vector of wireIdVectors.newest.filter((v) => v.nowMs === null)) {
      test(vector.name, () => {
        expect(hex(maxWireIdClock(vector.ids.map((id) => wireIdClock(id))))).toBe(vector.expected);
      });
    }
  });

  describe('wireIdClockDelta', () => {
    for (const vector of wireIdVectors.delta) {
      test(vector.name, () => {
        const delta = wireIdClockDelta(BigInt(`0x${vector.clock}`), BigInt(`0x${vector.reference}`));
        expect(delta).toBe(BigInt(vector.expected));
      });
    }
  });

  test('the fixture constants are the module constants', () => {
    expect(WIRE_ID_TIME_SCALE).toBe(BigInt(`0x${wireIdVectors.timeScaleHex}`));
    expect(WIRE_ID_TIME_MASK).toBe(BigInt(`0x${wireIdVectors.timeMaskHex}`));
    expect(WIRE_ID_CLOCK_TOLERANCE).toBe(BigInt(wireIdVectors.maxCorrectionMs) * WIRE_ID_TIME_SCALE);
  });
});

describe('mintWireMessageIdAbove', () => {
  test('the random tail is 14 base62 chars, and a source at 1 stays in range', () => {
    const at = (value: number) => mintWireMessageIdAbove({ nowMs: 1755500000000, random: () => value }).id;
    expect(at(0).slice(16)).toBe('00000000000000');
    expect(at(0.9999).slice(16)).toBe('zzzzzzzzzzzzzz');
    expect(at(1).slice(16)).toBe('zzzzzzzzzzzzzz');
    expect(at(0.5)).toMatch(WIRE_MESSAGE_ID);
  });

  test('backdateMs: 0 mints at the given clock itself', () => {
    const minted = mintWireMessageIdAbove({ nowMs: 1755500000000, backdateMs: 0, random: () => 0 });
    expect(minted.time).toBe(wireIdClockAt(1755500000000));
  });

  test('time is the clock the id encodes', () => {
    const minted = mintWireMessageIdAbove({ nowMs: 1755500000000 });
    expect(wireIdClock(minted.id)).toBe(minted.time);
  });
});

describe('WIRE_MESSAGE_ID', () => {
  test('accepts the full OpenCode shape only', () => {
    expect(WIRE_MESSAGE_ID.test('msg_8bbf25e40000AbCdEfGhIjKlMn')).toBe(true);
    expect(WIRE_MESSAGE_ID.test('msg_8bbf25e40000AbCd')).toBe(false);
    expect(WIRE_MESSAGE_ID.test('msg_8BBF25E40000AbCdEfGhIjKlMn')).toBe(false);
  });
});

describe('mintWireMessageId — the pre-fix CLI shape', () => {
  // 2026-09-24T14:09:50.760Z, the instant of a real CLI prompt.
  const nowMs = Date.parse('2026-09-24T14:09:50.760Z');

  test('encodes the LOW 48 bits, the way OpenCode does', () => {
    // The CLI wrote the HIGH 12 hex digits: `1a0d3c04ea80…` for this instant.
    // OpenCode's own clock for it starts `0d3c04ea8…`; the mint is dated two
    // minutes back, so `0d3b…`.
    const id = mintWireMessageId({ nowMs });
    expect(clockHex(id).startsWith('0d3b')).toBe(true);
    expect(wireIdClock(id)).toBe(wireIdClockAt(nowMs - 120_000));
  });

  test('is exported from the package root', () => {
    expect(mintFromRoot).toBe(mintWireMessageId);
  });

  test('a far-future id in the transcript does not drag the mint forward', () => {
    const cliId = 'msg_1a0d3bfa6280SyntheticCli02';
    const id = mintWireMessageId({ nowMs, after: [cliId] });
    expect(wireIdClock(id)).toBe(wireIdClockAt(nowMs - 120_000));
  });

  test('prefix rule: an id with a hex clock prefix lifts the mint, whatever its tail', () => {
    // Pinned on purpose: every host orders placed messages by the 12-char
    // prefix alone, so a mint must clear anything that sorts by that prefix.
    const id = mintWireMessageId({ nowMs: 1755500000000, after: ['msg_8bbf43300000_legacy'] });
    expect(clockHex(id)).toBe('8bbf43300001');
  });

  test('lifts across the 48-bit wrap', () => {
    // Newest reply sits just below the wrap; now is just after it.
    const wrapMs = Date.parse('2026-08-14T11:19:55.136Z');
    const newest = `msg_${wireIdClockAt(wrapMs + 60_000).toString(16).padStart(12, '0')}AAAAAAAAAAAAAA`;
    const id = mintWireMessageId({ nowMs: wrapMs + 90_000, after: [newest] });
    expect(wireIdClock(id)).toBe((wireIdClock(newest)! + BigInt(1)) & BigInt(0xffffffffffff));
  });
});

describe('isWireIdAheadOf', () => {
  const nowMs = Date.parse('2026-09-24T16:30:00.000Z');
  test('flags the CLI high-bits id', () => {
    expect(isWireIdAheadOf('msg_1a0d42f86f80SyntheticCli03', nowMs)).toBe(true);
  });
  test('accepts an OpenCode id minted minutes ago or seconds ahead', () => {
    expect(isWireIdAheadOf('msg_0d43d94e4000SyntheticWeb04', nowMs)).toBe(false);
    expect(isWireIdAheadOf(mintWireMessageId({ nowMs: nowMs + 150_000 }), nowMs)).toBe(false);
  });
  test('accepts ids from before the wrap', () => {
    expect(isWireIdAheadOf('msg_ffcb5ca00001aaaaaaaaaaaaaa', nowMs)).toBe(false);
  });
});

describe('wireIdClockDelta', () => {
  test('is antisymmetric across the wrap', () => {
    const pre = BigInt('0xffffffffff00');
    const post = BigInt('0x000000000100');
    expect(wireIdClockDelta(post, pre)).toBe(BigInt(0x200));
    expect(wireIdClockDelta(pre, post)).toBe(-BigInt(0x200));
  });
});

describe('maxWireIdClock', () => {
  test('skips null and undefined, and is null when nothing is left', () => {
    expect(maxWireIdClock([null, undefined])).toBeNull();
    expect(maxWireIdClock([null, BigInt(5), undefined, BigInt(3)])).toBe(BigInt(5));
  });
  test('the post-wrap clock wins over the pre-wrap one, in either order', () => {
    const pre = BigInt('0xfffff8ad0000');
    const post = BigInt('0x000007530000');
    expect(maxWireIdClock([pre, post])).toBe(post);
    expect(maxWireIdClock([post, pre])).toBe(post);
  });
});

describe('module shape', () => {
  test('wire-message-id.ts has no imports, so its subpath loads one file', () => {
    const source = readFileSync(resolve(import.meta.dir, 'wire-message-id.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*(import|export\s+(\*|\{[^}]*\})\s+from)\s/m);
  });
});
