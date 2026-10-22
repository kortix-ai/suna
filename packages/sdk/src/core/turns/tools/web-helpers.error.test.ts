import { describe, expect, test } from 'bun:test';

import { parseWebSearchOutput } from './web-helpers';

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

// KRTX-3016: a batch whose queries all failed rendered "5 searches" over five
// empty rows: each query's error was dropped here.
describe('parseWebSearchOutput on a failed batch', () => {
  const batch = (results: unknown[]) =>
    JSON.stringify({ batch_mode: true, total_queries: results.length, results });

  test('keeps each failed query with its error', () => {
    const parsed = parseWebSearchOutput(
      batch([
        { query: 'desk cable tray', success: false, error: 'Error: 432 Error: {"detail":"over plan quota"}' },
        { query: 'monitor riser', success: false, error: '' },
      ]),
    );
    expect(parsed).toEqual([
      { query: 'desk cable tray', answer: undefined, sources: [], error: 'Error: 432 Error: {"detail":"over plan quota"}' },
      { query: 'monitor riser', answer: undefined, sources: [], error: 'Search failed' },
    ]);
  });

  test('a successful query in the same batch carries no error', () => {
    const parsed = parseWebSearchOutput(
      batch([
        { query: 'ok', success: true, results: [{ title: 'A', url: 'https://a.example' }] },
        { query: 'bad', success: false, error: 'boom' },
      ]),
    );
    expect(parsed[0].error).toBeUndefined();
    expect(parsed[0].sources).toHaveLength(1);
    expect(parsed[1].error).toBe('boom');
  });
});
