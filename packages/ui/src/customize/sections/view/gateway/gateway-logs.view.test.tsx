import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GatewayLogRow } from '@kortix/sdk';

import {
  LogBucketCard,
  LogHistogram,
  bucketLogStats,
  bucketLogs,
  filterCounts,
  fmtRange,
  inLogRange,
  hasLogFilters,
  logSessionHref,
  matchesLogQuery,
  medianLatency,
  mergeLogFilters,
  NO_LOG_FILTERS,
  serverLogFilters,
  windowSince,
} from './gateway-logs';

function row(overrides: Partial<GatewayLogRow> = {}): GatewayLogRow {
  return {
    log_id: 'log-1',
    request_id: 'req-1',
    created_at: '2026-01-05T10:00:00.000Z',
    requested_model: 'openai/gpt-5',
    resolved_model: 'openai/gpt-5',
    provider: 'openai',
    status: 200,
    ok: true,
    error_code: null,
    error_message: null,
    latency_ms: 1200,
    attempts: 1,
    input_tokens: 100,
    output_tokens: 20,
    cached_tokens: 0,
    cache_write_tokens: 0,
    kortix_cost: 0,
    provider_cost: 0.001,
    total_cost: 0.001,
    upstream_cost: 0.001,
    final_cost: 0,
    streaming: true,
    billing_mode: 'none',
    actor_user_id: null,
    key_id: null,
    ...overrides,
  };
}

describe('matchesLogQuery — search over the loaded rows', () => {
  test('matches model, provider and error code, case-insensitively', () => {
    const failed = row({ ok: false, status: 429, provider: 'anthropic', error_code: 'rate_limit_error' });
    expect(matchesLogQuery(failed, 'ANTHROPIC')).toBe(true);
    expect(matchesLogQuery(failed, 'rate_limit')).toBe(true);
    expect(matchesLogQuery(row(), 'gpt-5')).toBe(true);
    expect(matchesLogQuery(row(), 'gemini')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(matchesLogQuery(row(), '   ')).toBe(true);
  });
});

describe('medianLatency', () => {
  test('odd and even counts, and none', () => {
    expect(medianLatency([{ latency_ms: 300 }, { latency_ms: 100 }, { latency_ms: 200 }])).toBe(200);
    expect(medianLatency([{ latency_ms: 100 }, { latency_ms: 300 }])).toBe(200);
    expect(medianLatency([])).toBeNull();
  });
});

describe('bucketLogs — the histogram counts the loaded window', () => {
  test('every row lands in exactly one bucket, failures counted separately', () => {
    const rows = [
      row({ created_at: '2026-01-05T10:00:00.000Z' }),
      row({ created_at: '2026-01-05T11:00:00.000Z', ok: false }),
      row({ created_at: '2026-01-05T12:00:00.000Z' }),
    ];
    const buckets = bucketLogs(rows, 4);
    expect(buckets).toHaveLength(4);
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(3);
    expect(buckets.reduce((n, b) => n + b.errors, 0)).toBe(1);
    expect(buckets[0].total).toBe(1);
    expect(buckets[3].total).toBe(1);
  });

  test('no rows, no buckets', () => {
    expect(bucketLogs([], 48)).toEqual([]);
  });
});

describe('filterCounts — tab counts never guess', () => {
  const rows = [row(), row({ ok: false }), row()];

  test('on All, the loaded rows answer all three tabs', () => {
    expect(filterCounts('all', rows, false)).toEqual({ all: 3, ok: 2, err: 1 });
  });

  test('on a narrowed tab only that tab has a count', () => {
    expect(filterCounts('err', [row({ ok: false })], false)).toEqual({ all: null, ok: null, err: 1 });
  });

  test('no counts while loading', () => {
    expect(filterCounts('all', [], true)).toEqual({ all: null, ok: null, err: null });
  });
});

describe('LogHistogram', () => {
  test('states requests, errors and median latency, and draws the bars', () => {
    const rows = [row({ latency_ms: 1000 }), row({ ok: false, latency_ms: 3000, created_at: '2026-01-05T12:00:00.000Z' })];
    const out = renderToStaticMarkup(<LogHistogram rows={rows} live />);
    expect(out).toContain('data-slot="log-histogram"');
    expect(out).toContain('requests');
    expect(out).toContain('error');
    expect(out).toContain('median latency');
    expect(out).toContain('2.0s');
    expect(out).toContain('Now');
    expect(out).toContain('bg-destructive');
    expect(out.match(/<button/g)?.length).toBe(48);
  });

  test('renders nothing with no rows', () => {
    expect(renderToStaticMarkup(<LogHistogram rows={[]} live={false} />)).toBe('');
  });
});

describe('bucketLogStats — what a hovered bar says', () => {
  test('per-bucket requests, errors, success rate, median latency, tokens, cost, top model', () => {
    const rows = [
      row({ created_at: '2026-01-05T10:00:00.000Z', latency_ms: 1000, input_tokens: 10, output_tokens: 5, total_cost: 0.01 }),
      row({
        created_at: '2026-01-05T10:00:30.000Z',
        ok: false,
        latency_ms: 3000,
        input_tokens: 0,
        output_tokens: 0,
        total_cost: 0,
        requested_model: 'anthropic/claude-sonnet-4.6',
      }),
      row({ created_at: '2026-01-05T10:00:40.000Z', latency_ms: 2000, input_tokens: 20, output_tokens: 5, total_cost: 0.02 }),
      row({ created_at: '2026-01-05T12:00:00.000Z' }),
    ];
    const [first, , last] = bucketLogStats(rows, 3);
    expect(first.total).toBe(3);
    expect(first.errors).toBe(1);
    expect(first.successRate).toBeCloseTo(2 / 3);
    expect(first.medianLatency).toBe(2000);
    expect(first.tokens).toBe(40);
    expect(first.cost).toBeCloseTo(0.03);
    expect(first.topModel).toContain('gpt-5');
    expect(last.end).toBe(new Date('2026-01-05T12:00:00.000Z').getTime());
  });

  test('an empty bucket has no rate, no median and no top model', () => {
    const rows = [row({ created_at: '2026-01-05T10:00:00.000Z' }), row({ created_at: '2026-01-05T12:00:00.000Z' })];
    const middle = bucketLogStats(rows, 3)[1];
    expect(middle.total).toBe(0);
    expect(middle.successRate).toBeNull();
    expect(middle.medianLatency).toBeNull();
    expect(middle.topModel).toBeNull();
  });
});

describe('a bar click narrows the list to its range', () => {
  test('inLogRange includes both ends; no range keeps every row', () => {
    const range = { start: Date.parse('2026-01-05T10:00:00.000Z'), end: Date.parse('2026-01-05T11:00:00.000Z') };
    expect(inLogRange(row({ created_at: '2026-01-05T10:00:00.000Z' }), range)).toBe(true);
    expect(inLogRange(row({ created_at: '2026-01-05T11:00:00.000Z' }), range)).toBe(true);
    expect(inLogRange(row({ created_at: '2026-01-05T11:00:01.000Z' }), range)).toBe(false);
    expect(inLogRange(row(), null)).toBe(true);
  });

  test('fmtRange reads start – end', () => {
    expect(fmtRange({ start: 0, end: 60_000 })).toContain(' – ');
  });
});

describe('LogBucketCard', () => {
  test('a bucket with traffic lists its stats, errors in red', () => {
    const [bucket] = bucketLogStats([row(), row({ ok: false })], 1);
    const out = renderToStaticMarkup(<LogBucketCard bucket={bucket} />);
    for (const label of ['Errors', 'Success rate', 'Median latency', 'Tokens', 'Cost', 'Top model']) {
      expect(out).toContain(label);
    }
    expect(out).toContain('50%');
    expect(out).toContain('text-destructive');
    expect(out).toContain('break-all');
    expect(out).not.toContain('gatewayLogs.');
  });

  test('an empty bucket says so', () => {
    const empty = { start: 0, end: 60_000, total: 0, errors: 0, successRate: null, medianLatency: null, tokens: 0, cost: 0, topModel: null };
    expect(renderToStaticMarkup(<LogBucketCard bucket={empty} />)).toContain('No requests');
  });
});

describe('logSessionHref — from a request to the message it produced', () => {
  test('names the exact message, the subagent thread and the request start', () => {
    const href = logSessionHref('p1', row({
      session_id: 's1',
      message_id: 'msg_reply',
      turn_id: 'msg_prompt',
      thread_id: 'ses_child',
      created_at: '2026-01-05T10:00:10.000Z',
      latency_ms: 4_000,
    }));
    const url = new URL(href!, 'https://x.test');
    expect(url.pathname).toBe('/workspaces/p1/sessions/s1');
    expect(url.searchParams.get('m')).toBe('msg_reply');
    expect(url.searchParams.get('rs')).toBe('ses_child');
    // The log is written when the request ends: `at` is when it started.
    expect(url.searchParams.get('at')).toBe(String(Date.parse('2026-01-05T10:00:06.000Z')));
  });

  test('falls back to the turn, then to the time alone', () => {
    const turnOnly = new URL(logSessionHref('p1', row({ session_id: 's1', turn_id: 'msg_prompt' }))!, 'https://x.test');
    expect(turnOnly.searchParams.get('m')).toBe('msg_prompt');
    const timeOnly = new URL(logSessionHref('p1', row({ session_id: 's1' }))!, 'https://x.test');
    expect(timeOnly.searchParams.get('m')).toBeNull();
    expect(timeOnly.searchParams.get('at')).not.toBeNull();
  });

  test('is null for a request from outside a session', () => {
    expect(logSessionHref('p1', row({ session_id: null }))).toBeNull();
  });
});

describe('server filters', () => {
  test('the menu state, the status tab and the search become one server query', () => {
    expect(
      serverLogFilters('err', { window: '1h', since: '2026-01-05T09:00:00.000Z', sessionId: 's1', model: 'm' }, '  req_1 '),
    ).toEqual({
      ok: false,
      sessionId: 's1',
      model: 'm',
      provider: undefined,
      errorCode: undefined,
      since: '2026-01-05T09:00:00.000Z',
      q: 'req_1',
    });
    expect(serverLogFilters('all', NO_LOG_FILTERS, '')).toEqual({
      sessionId: undefined,
      model: undefined,
      provider: undefined,
      errorCode: undefined,
      since: undefined,
      q: undefined,
    });
  });

  test('a window is a since time measured back from now', () => {
    const now = Date.parse('2026-01-05T10:00:00.000Z');
    expect(windowSince('1h', now)).toBe('2026-01-05T09:00:00.000Z');
    expect(windowSince('any', now)).toBeUndefined();
  });

  test('Clear filters clears every filter, not only the time window', () => {
    const set = { window: '1h' as const, since: 'x', sessionId: 's1', sessionTitle: 't', model: 'm', provider: 'p', errorCode: 'e' };
    const cleared = mergeLogFilters(set, NO_LOG_FILTERS);
    expect(hasLogFilters(cleared)).toBe(false);
    expect(serverLogFilters('all', cleared, '')).toEqual(serverLogFilters('all', NO_LOG_FILTERS, ''));
  });

  test('hasLogFilters is false only for the empty state', () => {
    expect(hasLogFilters(NO_LOG_FILTERS)).toBe(false);
    expect(hasLogFilters({ window: 'any', provider: 'kortix' })).toBe(true);
  });

  test('the search matches a request, session or message id exactly', () => {
    const r = row({ session_id: 'sess_1', message_id: 'msg_1' });
    expect(matchesLogQuery(r, 'req-1')).toBe(true);
    expect(matchesLogQuery(r, 'sess_1')).toBe(true);
    expect(matchesLogQuery(r, 'msg_1')).toBe(true);
    expect(matchesLogQuery(r, 'msg_')).toBe(false);
  });
});
