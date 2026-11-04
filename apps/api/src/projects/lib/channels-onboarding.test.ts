import { describe, expect, test } from 'bun:test';
import { generalNotice } from './channels-onboarding';

const AT = '2026-10-20T10:00:00.000Z';
const at = Date.parse(AT);
const DAY = 24 * 60 * 60 * 1000;
const meta = (channels: unknown) => ({ experimental: { project_channels: true }, channels });

describe('generalNotice', () => {
  test('present for 7 days after a turn-on again that filed sessions', () => {
    expect(generalNotice(meta({ reenabled_at: AT, reenabled_count: 3 }), at + 7 * DAY)).toEqual({ kind: 'reenabled', at: AT, count: 3 });
  });

  test('gone after 7 days', () => {
    expect(generalNotice(meta({ reenabled_at: AT, reenabled_count: 3 }), at + 7 * DAY + 1)).toBeUndefined();
  });

  test('absent when the turn-on again filed no session', () => {
    expect(generalNotice(meta({ reenabled_at: AT, reenabled_count: 0 }), at)).toBeUndefined();
  });

  test('absent for missing or malformed metadata', () => {
    expect(generalNotice({}, at)).toBeUndefined();
    expect(generalNotice(null, at)).toBeUndefined();
    expect(generalNotice(meta({ reenabled_at: 'not a date', reenabled_count: 2 }), at)).toBeUndefined();
    expect(generalNotice(meta({ reenabled_at: AT, reenabled_count: '2' }), at)).toBeUndefined();
  });
});
