import { describe, expect, test } from 'bun:test';
import { parseDuration, selectForPrune, type PruneCandidate } from '../lib';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-19T00:00:00Z');
const c = (o: Partial<PruneCandidate> & { name: string }): PruneCandidate => ({
  live: false, dirty: false, missing: false,
  createdAt: new Date(NOW - 10 * DAY).toISOString(), lastActivity: NOW - 5 * DAY, ...o,
});
const verdict = (cands: PruneCandidate[], rule = {}, now = NOW) =>
  Object.fromEntries(selectForPrune(cands, { includeDirty: false, ...rule }, now).map((v) => [v.name, v.nuke]));

describe('parseDuration', () => {
  test('units', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('12h')).toBe(12 * 3_600_000);
    expect(parseDuration('3d')).toBe(3 * DAY);
    expect(parseDuration('2w')).toBe(14 * DAY);
    expect(parseDuration(' 1.5d ')).toBe(1.5 * DAY);
  });
  test('rejects garbage', () => {
    for (const s of ['', '3', 'd3', '3 days', '3s', '-1d']) expect(() => parseDuration(s)).toThrow();
  });
});

describe('selectForPrune', () => {
  test('no rule: every stopped clean slot is selected', () => {
    expect(verdict([c({ name: 'a' }), c({ name: 'b' })])).toEqual({ a: true, b: true });
  });
  test('running stacks are never selected, even when dirty/old/missing flags say otherwise', () => {
    expect(verdict([c({ name: 'run', live: true, missing: true })], { includeDirty: true })).toEqual({ run: false });
  });
  test('missing directory is always freed, even when dirty rule would keep it', () => {
    expect(verdict([c({ name: 'gone', missing: true, dirty: true })])).toEqual({ gone: true });
  });
  test('dirty is kept unless --include-dirty', () => {
    expect(verdict([c({ name: 'd', dirty: true })])).toEqual({ d: false });
    expect(verdict([c({ name: 'd', dirty: true })], { includeDirty: true })).toEqual({ d: true });
  });
  test('--older-than compares createdAt', () => {
    const cands = [
      c({ name: 'old', createdAt: new Date(NOW - 10 * DAY).toISOString() }),
      c({ name: 'new', createdAt: new Date(NOW - 1 * DAY).toISOString() }),
      c({ name: 'unknown', createdAt: 'not-a-date' }),
    ];
    expect(verdict(cands, { olderThanMs: 3 * DAY })).toEqual({ old: true, new: false, unknown: false });
  });
  test('--idle compares lastActivity and falls back to createdAt when unknown', () => {
    const cands = [
      c({ name: 'idle', lastActivity: NOW - 5 * DAY }),
      c({ name: 'busy', lastActivity: NOW - 3_600_000 }),
      c({ name: 'noact', lastActivity: null, createdAt: new Date(NOW - 9 * DAY).toISOString() }),
      c({ name: 'noact-new', lastActivity: null, createdAt: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    expect(verdict(cands, { idleMs: 2 * DAY })).toEqual({ idle: true, busy: false, noact: true, 'noact-new': false });
  });
  test('both rules must pass', () => {
    const cands = [
      c({ name: 'old-but-active', createdAt: new Date(NOW - 30 * DAY).toISOString(), lastActivity: NOW - 3_600_000 }),
      c({ name: 'new-but-idle', createdAt: new Date(NOW - 1 * DAY).toISOString(), lastActivity: NOW - 1 * DAY }),
      c({ name: 'old-and-idle', createdAt: new Date(NOW - 30 * DAY).toISOString(), lastActivity: NOW - 10 * DAY }),
    ];
    expect(verdict(cands, { olderThanMs: 3 * DAY, idleMs: 2 * DAY })).toEqual({ 'old-but-active': false, 'new-but-idle': false, 'old-and-idle': true });
  });
  test('every verdict carries a reason', () => {
    for (const v of selectForPrune([c({ name: 'a' }), c({ name: 'b', live: true }), c({ name: 'c', dirty: true })], { includeDirty: false }, NOW)) {
      expect(v.why.length).toBeGreaterThan(0);
    }
  });
});
