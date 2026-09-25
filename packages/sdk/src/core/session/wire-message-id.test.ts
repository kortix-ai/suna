import { describe, expect, test } from 'bun:test';
import wireIdVectors from '../../../../../tests/spec/wire-message-id.vectors.json';
import { mintWireMessageId as mintFromRoot } from '../../index';
import {
  WIRE_ID_CLOCK_TOLERANCE,
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  mintWireMessageId,
  mintWireMessageIdAbove,
  newestWireIdClock,
  unwrapWireIdClock,
  wireIdClock,
  wireIdClockAt,
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

describe('unwrapWireIdClock', () => {
  test('orders ids from both sides of the 2026-08-14 wrap', () => {
    const before = unwrapWireIdClock(BigInt('0xffcb5ca00001'), BigInt(Date.parse('2026-08-13T20:00:00Z')) * BigInt(4096));
    const after = unwrapWireIdClock(BigInt('0x00024b200001'), BigInt(Date.parse('2026-08-14T12:00:00Z')) * BigInt(4096));
    expect(before < after).toBe(true);
  });
});
