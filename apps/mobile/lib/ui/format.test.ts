import { describe, expect, test } from 'bun:test';
import { formatRelativeTime, projectToRow } from './format';

const NOW = Date.parse('2026-07-07T12:00:00Z');

describe('formatRelativeTime', () => {
  test('under a minute → just now', () => {
    expect(formatRelativeTime('2026-07-07T11:59:30Z', NOW)).toBe('just now');
  });
  test('minutes', () => {
    expect(formatRelativeTime('2026-07-07T11:57:00Z', NOW)).toBe('3m');
  });
  test('hours', () => {
    expect(formatRelativeTime('2026-07-07T10:00:00Z', NOW)).toBe('2h');
  });
  test('days', () => {
    expect(formatRelativeTime('2026-07-02T12:00:00Z', NOW)).toBe('5d');
  });
  test('older → month day', () => {
    expect(formatRelativeTime('2026-03-04T12:00:00Z', NOW)).toBe('Mar 4');
  });
});

describe('projectToRow', () => {
  test('maps project_id + relative subtitle', () => {
    const row = projectToRow({ project_id: 'p1', name: 'Alpha', updated_at: '2026-07-07T11:57:00Z' }, NOW);
    expect(row).toEqual({ id: 'p1', title: 'Alpha', subtitle: 'Updated 3m' });
  });
});
