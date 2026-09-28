import { describe, expect, test } from 'bun:test';
import { absoluteWireIdClockAt, unwrapWireIdClock } from './wire-id-unwrap';
import { wireIdClockAt } from './wire-message-id';

describe('unwrapWireIdClock', () => {
  test('orders ids from both sides of the 2026-08-14 wrap', () => {
    const before = unwrapWireIdClock(BigInt('0xffcb5ca00001'), BigInt(Date.parse('2026-08-13T20:00:00Z')) * BigInt(4096));
    const after = unwrapWireIdClock(BigInt('0x00024b200001'), BigInt(Date.parse('2026-08-14T12:00:00Z')) * BigInt(4096));
    expect(before < after).toBe(true);
  });
});

describe('absoluteWireIdClockAt', () => {
  test('masks down to the 48-bit clock OpenCode writes', () => {
    const ms = Date.parse('2026-09-24T14:09:50.760Z');
    expect(absoluteWireIdClockAt(ms) & BigInt(0xffffffffffff)).toBe(wireIdClockAt(ms));
  });
});
