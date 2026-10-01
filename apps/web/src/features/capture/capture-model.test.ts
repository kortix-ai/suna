import { describe, expect, test } from 'bun:test';

import { chunkSpan, dayBounds, deviceStatus, snippetParts } from './capture-model';

describe('snippetParts', () => {
  test('marks matches and never yields markup', () => {
    expect(snippetParts('see <b>invoice</b> total <script>x</script>')).toEqual([
      { text: 'see ', match: false },
      { text: 'invoice', match: true },
      { text: ' total <script>x</script>', match: false },
    ]);
  });
  test('plain text is one part', () => {
    expect(snippetParts('hello')).toEqual([{ text: 'hello', match: false }]);
  });
});

describe('chunkSpan', () => {
  test('places a one-hour chunk at noon on a 24 h track', () => {
    const { from } = dayBounds('2026-10-01');
    const start = Date.parse(from) + 12 * 3600_000;
    const span = chunkSpan(
      {
        started_at: new Date(start).toISOString(),
        ended_at: new Date(start + 3600_000).toISOString(),
      },
      '2026-10-01',
    );
    expect(span.left).toBeCloseTo(50, 1);
    expect(span.width).toBeCloseTo(100 / 24, 1);
  });
});

describe('deviceStatus', () => {
  const now = Date.parse('2026-10-01T10:00:00Z');
  test('workspace off wins', () => {
    expect(deviceStatus({ enabled: true, paused_until: null, account_enabled: false }, now)).toBe(
      'workspace_off',
    );
  });
  test('paused only while paused_until is in the future', () => {
    expect(
      deviceStatus(
        { enabled: true, paused_until: '2026-10-01T11:00:00Z', account_enabled: true },
        now,
      ),
    ).toBe('paused');
    expect(
      deviceStatus(
        { enabled: true, paused_until: '2026-10-01T09:00:00Z', account_enabled: true },
        now,
      ),
    ).toBe('recording');
    expect(deviceStatus({ enabled: false, paused_until: null, account_enabled: true }, now)).toBe(
      'off',
    );
  });
});
