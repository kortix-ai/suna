import { describe, expect, test } from 'bun:test';

import { parseWebSearchOutput } from '@/features/session/tool/shared/web-helpers';

describe('parseWebSearchOutput on failure', () => {
  test('returns no results when the payload is a top-level failure with a query', () => {
    const payload = JSON.stringify({
      query: 'Kortix AI platform founder CEO',
      success: false,
      error: 'Error: An unexpected error occurred while making the request.',
    });
    expect(parseWebSearchOutput(payload)).toEqual([]);
  });

  test('returns no results for a bare failure object', () => {
    expect(parseWebSearchOutput(JSON.stringify({ success: false, error: 'boom' }))).toEqual([]);
  });

  test('still parses a successful single-query payload', () => {
    const payload = JSON.stringify({
      query: 'kortix',
      results: [{ title: 'Kortix', url: 'https://kortix.com' }],
    });
    const parsed = parseWebSearchOutput(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sources).toHaveLength(1);
  });
});
