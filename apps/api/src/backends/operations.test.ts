import { describe, expect, test } from 'bun:test';

const { OPERATION_STALE_MS, backendOperation } = await import('./operations');

const row = (metadata: Record<string, unknown>) => ({ metadata }) as never;
const now = Date.parse('2026-10-07T00:00:00.000Z');

describe('backendOperation', () => {
  test('a fresh resize is in flight; idle and stale ones are not', () => {
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(backendOperation(row({}), now)).toBeNull();
    expect(backendOperation(row({ operation: 'resizing', operationStartedAt: at(60_000) }), now)).toBe('resizing');
    // The API process that ran it died: the marker must not block the backend forever.
    expect(backendOperation(row({ operation: 'resizing', operationStartedAt: at(OPERATION_STALE_MS + 1) }), now)).toBeNull();
    expect(backendOperation(row({ operation: 'resizing' }), now)).toBe('resizing');
  });
});
