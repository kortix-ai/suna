import { describe, expect, test } from 'bun:test';

import { readSendStartedAtMs, sinceSendMsByMark } from './engine';

describe('readSendStartedAtMs', () => {
  test('reads a stored send instant from a queued payload', () => {
    expect(readSendStartedAtMs({ text: 'hi', sendStartedAtMs: 1_769_999_990_000 })).toBe(
      1_769_999_990_000,
    );
  });

  test('answers null for a payload without one, or with a non-number', () => {
    expect(readSendStartedAtMs({ text: 'hi' })).toBeNull();
    expect(readSendStartedAtMs({ sendStartedAtMs: '1769999990000' })).toBeNull();
    expect(readSendStartedAtMs(null)).toBeNull();
  });
});

describe('sinceSendMsByMark', () => {
  const SEND_MS = 1_770_000_000_000;

  test('each delivery mark reports the milliseconds since the user pressed Send', () => {
    const marks = [
      { label: 'admission', atMs: 40, deltaMs: 40 },
      { label: 'open-ready', atMs: 21_040, deltaMs: 21_000 },
      { label: 'env-sync', atMs: 21_900, deltaMs: 860 },
      { label: 'delivered', atMs: 22_300, deltaMs: 400 },
      { label: 'marked', atMs: 22_320, deltaMs: 20 },
    ];
    // The drain claimed the row 260 ms after Send.
    expect(sinceSendMsByMark(marks, SEND_MS + 260, SEND_MS)).toEqual({
      admission: 300,
      'open-ready': 21_300,
      'env-sync': 22_160,
      delivered: 22_560,
      marked: 22_580,
    });
  });

  test('a negative interval (client clock ahead of the server) is null, not a negative number', () => {
    const marks = [
      { label: 'admission', atMs: 10, deltaMs: 10 },
      { label: 'open-ready', atMs: 5_000, deltaMs: 4_990 },
    ];
    // The browser clock runs 2 s ahead: Send reads 2 s after the drain started.
    expect(sinceSendMsByMark(marks, SEND_MS - 2_000, SEND_MS)).toEqual({
      admission: null,
      'open-ready': 3_000,
    });
  });

  test('a repeated label reports its latest mark', () => {
    const marks = [
      { label: 'delivered', atMs: 1_000, deltaMs: 1_000 },
      { label: 'delivered', atMs: 4_000, deltaMs: 3_000 },
    ];
    expect(sinceSendMsByMark(marks, SEND_MS, SEND_MS)).toEqual({ delivered: 4_000 });
  });

  test('no send instant means no field at all', () => {
    expect(sinceSendMsByMark([{ label: 'admission', atMs: 1 }], SEND_MS, null)).toBeNull();
  });
});
