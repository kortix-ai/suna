import { describe, expect, test } from 'bun:test';
import { relativeAgoLabel, threadStatus } from './thread-status';

describe('threadStatus', () => {
  test('needsYou wins over isBusy', () => {
    const result = threadStatus({
      isBusy: true,
      needsYou: true,
      workingStartedAtMs: 0,
      lastActivityAtMs: null,
      nowMs: 120_000,
    });
    expect(result).toEqual({ kind: 'needs-you', label: 'Needs you' });
  });

  test('needsYou wins over idle', () => {
    const result = threadStatus({
      isBusy: false,
      needsYou: true,
      workingStartedAtMs: null,
      lastActivityAtMs: 0,
      nowMs: 120_000,
    });
    expect(result?.kind).toBe('needs-you');
  });

  test('working with no start timestamp reads bare "Working"', () => {
    const result = threadStatus({
      isBusy: true,
      needsYou: false,
      workingStartedAtMs: null,
      lastActivityAtMs: null,
      nowMs: 120_000,
    });
    expect(result).toEqual({ kind: 'working', label: 'Working' });
  });

  test('working under a minute reads bare "Working" (no "0 min")', () => {
    const result = threadStatus({
      isBusy: true,
      needsYou: false,
      workingStartedAtMs: 100_000,
      lastActivityAtMs: null,
      nowMs: 130_000, // 30s elapsed
    });
    expect(result).toEqual({ kind: 'working', label: 'Working' });
  });

  test('working rounds elapsed minutes ("90s" -> "2 min")', () => {
    const result = threadStatus({
      isBusy: true,
      needsYou: false,
      workingStartedAtMs: 0,
      lastActivityAtMs: null,
      nowMs: 90_000,
    });
    expect(result).toEqual({ kind: 'working', label: 'Working · 2 min' });
  });

  test('working at exactly 1 minute reads "1 min"', () => {
    const result = threadStatus({
      isBusy: true,
      needsYou: false,
      workingStartedAtMs: 0,
      lastActivityAtMs: null,
      nowMs: 60_000,
    });
    expect(result).toEqual({ kind: 'working', label: 'Working · 1 min' });
  });

  test('idle with no activity timestamp reads bare "Done"', () => {
    const result = threadStatus({
      isBusy: false,
      needsYou: false,
      workingStartedAtMs: null,
      lastActivityAtMs: null,
      nowMs: 120_000,
    });
    expect(result).toEqual({ kind: 'done', label: 'Done' });
  });

  test('idle under a minute reads "Done · just now"', () => {
    const result = threadStatus({
      isBusy: false,
      needsYou: false,
      workingStartedAtMs: null,
      lastActivityAtMs: 100_000,
      nowMs: 110_000,
    });
    expect(result).toEqual({ kind: 'done', label: 'Done · just now' });
  });

  test('idle three minutes ago reads "Done · 3 min ago"', () => {
    const result = threadStatus({
      isBusy: false,
      needsYou: false,
      workingStartedAtMs: null,
      lastActivityAtMs: 0,
      nowMs: 3 * 60_000,
    });
    expect(result).toEqual({ kind: 'done', label: 'Done · 3 minutes ago' });
  });

  test('idle hours and days ago read in hours and days', () => {
    const base = { isBusy: false, needsYou: false, workingStartedAtMs: null, lastActivityAtMs: 0 };
    expect(threadStatus({ ...base, nowMs: 2 * 3_600_000 + 5 * 60_000 })?.label).toBe('Done · 2 hours ago');
    expect(threadStatus({ ...base, nowMs: 3 * 86_400_000 })?.label).toBe('Done · 3 days ago');
  });

  test('a new session with no message has no status line, never "Done · just now"', () => {
    expect(
      threadStatus({
        isBusy: false,
        needsYou: false,
        workingStartedAtMs: null,
        lastActivityAtMs: 100_000,
        hasMessages: false,
        nowMs: 110_000,
      }),
    ).toBeNull();
  });

  test('a new session that is already working still reads "Working"', () => {
    expect(
      threadStatus({
        isBusy: true,
        needsYou: false,
        workingStartedAtMs: null,
        lastActivityAtMs: null,
        hasMessages: false,
        nowMs: 0,
      })?.label,
    ).toBe('Working');
  });

  test('working an hour or more reads whole hours', () => {
    const base = { isBusy: true, needsYou: false, lastActivityAtMs: null, workingStartedAtMs: 0 };
    expect(threadStatus({ ...base, nowMs: 59 * 60_000 + 40_000 })?.label).toBe('Working · 59 min');
    expect(threadStatus({ ...base, nowMs: 95 * 60_000 })?.label).toBe('Working · 1 hr');
  });

  test('isBusy false with a stale workingStartedAtMs is ignored (reads idle)', () => {
    const result = threadStatus({
      isBusy: false,
      needsYou: false,
      workingStartedAtMs: 0,
      lastActivityAtMs: 0,
      nowMs: 5 * 60_000,
    });
    expect(result?.kind).toBe('done');
  });
});

describe('relativeAgoLabel', () => {
  test('under a minute is "just now"', () => {
    expect(relativeAgoLabel(0)).toBe('just now');
    expect(relativeAgoLabel(59_999)).toBe('just now');
  });

  test('minutes, hours, days — the session list buckets (spokenRelative)', () => {
    expect(relativeAgoLabel(60_000)).toBe('1 minute ago');
    expect(relativeAgoLabel(7 * 60_000)).toBe('7 minutes ago');
    expect(relativeAgoLabel(3_600_000)).toBe('1 hour ago');
    expect(relativeAgoLabel(5 * 3_600_000)).toBe('5 hours ago');
    expect(relativeAgoLabel(2 * 86_400_000)).toBe('2 days ago');
  });

  test('non-finite input is treated as "just now" (never throws / NaN label)', () => {
    expect(relativeAgoLabel(Number.NaN)).toBe('just now');
    expect(relativeAgoLabel(-500)).toBe('just now');
  });
});
