/**
 * `kortix audit` — the two pure pieces worth pinning.
 *
 * The rest of the command is request plumbing and terminal formatting; these
 * two decide whether the numbers a person reads are the numbers they asked for.
 *
 * `--since 24h` is the flag everyone will actually type. It resolves against
 * the caller's clock into the ISO instant the API speaks, and a value we cannot
 * parse must REFUSE rather than fall through — a time bound that silently does
 * not apply makes a partial audit read look complete, which is the one failure
 * an audit tool must not have.
 */
import { describe, expect, test } from 'bun:test';

import { buildAuditQuery, exportBodyText, resolveInstant, truncate } from '../commands/audit.ts';

const NOW = new Date('2026-08-05T12:00:00.000Z');

describe('resolveInstant', () => {
  test.each([
    ['30m', '2026-08-05T11:30:00.000Z'],
    ['24h', '2026-08-04T12:00:00.000Z'],
    ['7d', '2026-07-29T12:00:00.000Z'],
    ['2w', '2026-07-22T12:00:00.000Z'],
  ])('%s resolves relative to now', (input, expected) => {
    expect(resolveInstant(input, NOW)).toBe(expected);
  });

  test('is case- and space-insensitive, because people type both', () => {
    expect(resolveInstant('24H', NOW)).toBe('2026-08-04T12:00:00.000Z');
    expect(resolveInstant(' 24 h ', NOW)).toBe('2026-08-04T12:00:00.000Z');
  });

  test('an ISO instant passes through normalized', () => {
    expect(resolveInstant('2026-08-01T00:00:00Z', NOW)).toBe('2026-08-01T00:00:00.000Z');
  });

  test.each([
    ['empty', ''],
    ['nonsense', 'yesterday'],
    ['unknown unit', '5y'],
    ['zero span', '0h'],
    ['negative', '-3d'],
  ])('%s is rejected, never coerced to now', (_label, input) => {
    expect(resolveInstant(input, NOW)).toBeNull();
  });
});

describe('buildAuditQuery', () => {
  test('maps CLI flag names onto the API query names', () => {
    // The flags are kebab-case for humans; the route takes snake_case. A silent
    // mismatch here would drop the filter and widen the result set.
    const built = buildAuditQuery(
      {
        action: 'iam.',
        actor: 'user-1',
        actorType: 'agent',
        project: 'proj-1',
        session: 'sess-1',
        source: 'cli',
        outcome: 'denied',
        resourceType: 'secret',
        requestId: 'req-1',
        correlationId: 'corr-1',
        query: 'rotate',
      },
      NOW,
    );
    expect('search' in built).toBe(true);
    const search = (built as { search: URLSearchParams }).search;
    expect(Object.fromEntries(search)).toEqual({
      action: 'iam.',
      actor: 'user-1',
      actor_type: 'agent',
      project_id: 'proj-1',
      session_id: 'sess-1',
      source: 'cli',
      outcome: 'denied',
      resource_type: 'secret',
      request_id: 'req-1',
      correlation_id: 'corr-1',
      q: 'rotate',
    });
  });

  test('omits every filter that was not passed', () => {
    const built = buildAuditQuery({}, NOW);
    expect([...(built as { search: URLSearchParams }).search.keys()]).toEqual([]);
  });

  test('resolves --since and --until to ISO', () => {
    const built = buildAuditQuery({ since: '24h', until: '2026-08-05T00:00:00Z' }, NOW);
    const search = (built as { search: URLSearchParams }).search;
    expect(search.get('since')).toBe('2026-08-04T12:00:00.000Z');
    expect(search.get('until')).toBe('2026-08-05T00:00:00.000Z');
  });

  test('REFUSES an unparseable --since instead of dropping it', () => {
    // The failure that matters. Dropping the bound would return events from all
    // time under a heading the user believes is scoped to a window.
    const built = buildAuditQuery({ since: 'last tuesday' }, NOW);
    expect('error' in built).toBe(true);
    expect((built as { error: string }).error).toContain('--since');
  });

  test('REFUSES an unparseable --until too', () => {
    const built = buildAuditQuery({ until: 'soon' }, NOW);
    expect('error' in built).toBe(true);
    expect((built as { error: string }).error).toContain('--until');
  });

  test('a rejected bound never leaves a partial query behind', () => {
    // If this returned the search params alongside the error, a caller that
    // ignored the error would issue an unbounded query.
    const built = buildAuditQuery({ action: 'iam.', since: 'nope' }, NOW);
    expect('search' in built).toBe(false);
  });
});

/**
 * The JSONL export came back as the string "{}" the first time it ran against
 * dev. The shared HTTP client parses `application/json`, passes `text/*`
 * through, and returns a **Blob** for anything else — and the export is
 * `application/x-ndjson`, which matches neither. `JSON.stringify(blob)` is
 * `"{}"`, so the command printed an empty object where the export belonged.
 * CSV was fine throughout (`text/csv`), which is what made it easy to miss.
 */
describe('exportBodyText', () => {
  test('a Blob body is read as text, not stringified', async () => {
    const blob = new Blob(['{"event_id":"a"}\n{"event_id":"b"}\n'], {
      type: 'application/x-ndjson',
    });
    const text = await exportBodyText(blob);
    expect(text).toContain('"event_id":"a"');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).not.toBe('{}');
  });

  test('a string body passes through untouched', async () => {
    expect(await exportBodyText('event_id,occurred_at\n1,2026-01-01\n')).toBe(
      'event_id,occurred_at\n1,2026-01-01\n',
    );
  });
});

describe('truncate', () => {
  test('leaves a short action alone', () => {
    expect(truncate('auth.login.success', 52)).toBe('auth.login.success');
  });

  test('caps a long action so the table keeps its shape', () => {
    // Audit actions are raw HTTP lines carrying UUIDs; uncapped, RESOURCE ended
    // up off the right edge of the terminal.
    const long = `GET /v1/accounts/${'a'.repeat(60)}`;
    const out = truncate(long, 52);
    expect(out).toHaveLength(52);
    expect(out.endsWith('…')).toBe(true);
  });
});
