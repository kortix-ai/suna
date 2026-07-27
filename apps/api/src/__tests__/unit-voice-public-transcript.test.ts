import { describe, expect, test } from 'bun:test';
import { parseTranscriptQuery } from '../channels/voice/public-join-routes';

/**
 * Query handling for `GET /v1/public/voice-join/:token/transcript`.
 *
 * Deliberately mock-free — `parseTranscriptQuery` is pure precisely so this
 * can be tested without a module mock of livekit/db/config, which in bun's
 * global mock registry would leak into every other unit file in the same run.
 * The route's behaviour end to end (scoping, 404/410, attribution) is covered
 * against the real DB in integration-voice-join-links.test.ts.
 */
describe('parseTranscriptQuery', () => {
  test('no query at all reads the call from the beginning, whole page', () => {
    expect(parseTranscriptQuery(undefined, undefined)).toEqual({ cursor: 0, limit: 200 });
  });

  test('a real cursor is passed through', () => {
    expect(parseTranscriptQuery('12', undefined).cursor).toBe(12);
  });

  for (const raw of ['abc', '', '-5', 'NaN', 'Infinity', '  ', '%20']) {
    test(`a mangled cursor (${JSON.stringify(raw)}) restarts from the beginning rather than 400ing`, () => {
      // A truncated or hand-edited join link should show the call, not an
      // error — the worst a bad cursor can mean is "start from the top".
      expect(parseTranscriptQuery(raw, undefined).cursor).toBe(0);
    });
  }

  test('a trailing-garbage cursor still yields the number it starts with', () => {
    expect(parseTranscriptQuery('12abc', undefined).cursor).toBe(12);
  });

  test('an absurd cursor is clamped instead of reaching Postgres outside bigint', () => {
    // `parseInt` returns 1e20 here quite happily; handing that to the query
    // would turn a bad query string into a 500.
    expect(parseTranscriptQuery('99999999999999999999', undefined).cursor).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test('limit is clamped to the ceiling — one anonymous request cannot ask for the world', () => {
    expect(parseTranscriptQuery(undefined, '99999').limit).toBe(200);
  });

  test('limit is clamped up from zero and negatives, never to an empty page', () => {
    expect(parseTranscriptQuery(undefined, '0').limit).toBe(1);
    expect(parseTranscriptQuery(undefined, '-20').limit).toBe(1);
  });

  test('a sane limit is honoured', () => {
    expect(parseTranscriptQuery(undefined, '50').limit).toBe(50);
  });

  test('an unparseable limit falls back to the full page rather than to zero', () => {
    expect(parseTranscriptQuery(undefined, 'lots').limit).toBe(200);
  });
});
