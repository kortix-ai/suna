/**
 * The runtime-projection VERDICT — the rule that decides whether a cached
 * runtime document may be presented as an answer.
 *
 * `resolveRuntimeLeg` is pure, so every case here is a fact about the contract
 * rather than about a database. The cases that matter are the refusals: a
 * projection served when it should not have been is a ghost roster, and a
 * ghost roster is indistinguishable from a real one at the UI.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  PROJECTION_MAX_AGE_MS,
  projectionIdentity,
  resolveRuntimeLeg,
  capturedAtNotNewerThan,
  type RuntimeProjectionRead,
} from './session-runtime-projection';

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

function read(overrides: Partial<RuntimeProjectionRead> = {}): RuntimeProjectionRead {
  return {
    row: {
      sessionId: 'sess-1',
      projectId: 'proj-1',
      accountId: 'acct-1',
      externalId: 'box-1',
      identity: {
        opencode_session_id: 'ses_abc',
        opencode_version: '1.18.23',
        daemon_build: 1756240000,
        agent_config_etag: 'ff8a8b4f',
        head_seq: { ses_abc: 2016 },
      },
      epoch: 'bmtaokkdb0piayh',
      seq: 41,
      projectionEtag: 'sha256:9f1c',
      projection: { epoch: 'bmtaokkdb0piayh', seq: 41, agents: { known: true, value: [] } },
      source: 'daemon_push',
      capturedAt: new Date(NOW - 60_000),
    },
    pinnedOpencodeSessionId: 'ses_abc',
    runtimeRunning: true,
    ...overrides,
  };
}

describe('resolveRuntimeLeg', () => {
  test('a matching, recent projection is served with its cursor and identity', () => {
    const leg = resolveRuntimeLeg(read(), NOW);
    expect(leg.known).toBe(true);
    if (!leg.known) throw new Error('unreachable');
    expect(leg.fresh).toBe(true);
    expect(leg.age_ms).toBe(60_000);
    expect(leg.source).toBe('daemon_push');
    // The cursor a client hands straight to `stream(?epoch=&since=)`.
    expect(leg.epoch).toBe('bmtaokkdb0piayh');
    expect(leg.seq).toBe(41);
    expect(leg.identity.opencode_version).toBe('1.18.23');
    expect(leg.state).toMatchObject({ seq: 41 });
  });

  test('no row is `no_projection` — never an empty roster', () => {
    const leg = resolveRuntimeLeg(read({ row: null }), NOW);
    expect(leg).toEqual({ known: false, reason: 'no_projection' });
  });

  test('a projection from a DIFFERENT OpenCode root is refused (the ghost rule)', () => {
    const leg = resolveRuntimeLeg(read({ pinnedOpencodeSessionId: 'ses_reprinned' }), NOW);
    expect(leg).toEqual({ known: false, reason: 'identity_mismatch' });
  });

  test('a session with no pin yet is NOT a mismatch', () => {
    // A cold box mid-boot has no pin. Refusing here would blank the roster for
    // exactly the session that most needs it painted.
    const leg = resolveRuntimeLeg(read({ pinnedOpencodeSessionId: null }), NOW);
    expect(leg.known).toBe(true);
  });

  test('a RUNNING box past the max age is `stale`', () => {
    const stale = read();
    stale.row!.capturedAt = new Date(NOW - PROJECTION_MAX_AGE_MS - 1);
    expect(resolveRuntimeLeg(stale, NOW)).toEqual({ known: false, reason: 'stale' });
  });

  test('a STOPPED box never goes stale — its projection is the last true state', () => {
    const stopped = read({ runtimeRunning: false });
    stopped.row!.capturedAt = new Date(NOW - 30 * 60 * 60_000);
    const leg = resolveRuntimeLeg(stopped, NOW);
    expect(leg.known).toBe(true);
    if (!leg.known) throw new Error('unreachable');
    expect(leg.fresh).toBe(true);
    expect(leg.runtime_running).toBe(false);
    expect(leg.age_ms).toBe(30 * 60 * 60_000);
  });

  test('exactly at the max age a running box is still served', () => {
    const edge = read();
    edge.row!.capturedAt = new Date(NOW - PROJECTION_MAX_AGE_MS);
    expect(resolveRuntimeLeg(edge, NOW).known).toBe(true);
  });

  test('a clock skew in the future clamps to age 0 instead of going negative', () => {
    const future = read();
    future.row!.capturedAt = new Date(NOW + 5_000);
    const leg = resolveRuntimeLeg(future, NOW);
    if (!leg.known) throw new Error('unreachable');
    expect(leg.age_ms).toBe(0);
  });
});

describe('projectionIdentity', () => {
  test('reads the daemon document verbatim', () => {
    expect(
      projectionIdentity({
        identity: {
          opencode_session_id: 'ses_x',
          opencode_version: '1.18.23',
          daemon_build: 42,
          agent_config_etag: 'abc',
          head_seq: { ses_x: 7 },
        },
      }),
    ).toEqual({
      opencode_session_id: 'ses_x',
      opencode_version: '1.18.23',
      daemon_build: 42,
      agent_config_etag: 'abc',
      head_seq: { ses_x: 7 },
    });
  });

  test('a document without an identity block yields nulls, not throws', () => {
    expect(projectionIdentity({})).toEqual({
      opencode_session_id: null,
      opencode_version: null,
      daemon_build: null,
      agent_config_etag: null,
      head_seq: null,
    });
    expect(projectionIdentity(null).opencode_session_id).toBeNull();
  });

  test('an empty-string id reads as absent, so it can never be "matched"', () => {
    // `''` is what an unset env var arrives as. Treating it as a value would
    // make two boxes with no config etag look like a match.
    expect(projectionIdentity({ identity: { agent_config_etag: '' } }).agent_config_etag).toBeNull();
  });

  test('a head_seq that is not a map is dropped rather than half-trusted', () => {
    expect(projectionIdentity({ identity: { head_seq: [1, 2] } }).head_seq).toBeNull();
    expect(projectionIdentity({ identity: { head_seq: 2016 } }).head_seq).toBeNull();
  });
});

// ── The out-of-order guard's SQL binding ────────────────────────────────────
// `capturedAtNotNewerThan` is a raw `sql` fragment. Drizzle's `.values()`/`set`
// column bindings map a JS Date correctly, but a raw fragment does not: it hands
// postgres-js the Date, which serializes it with its locale `toString()`
// ("Thu Aug 27 2026 03:01:29 GMT+0200 (CEST)"). Postgres cannot parse that as a
// timestamp, so EVERY real push 500'd on the upsert while this file's other
// tests — which never touch a real DB — stayed green. Verified live on a
// Platinum box (2026-08-27): the fix turned the push from a 500 into a stored
// row. These pin the compiled parameter so the raw Date can never come back.
describe('capturedAtNotNewerThan (the upsert out-of-order guard)', () => {
  const capturedAt = new Date(Date.UTC(2026, 7, 27, 1, 1, 29, 468));

  test('binds an ISO string with a ::timestamptz cast, never a raw Date', () => {
    const q = new PgDialect().sqlToQuery(capturedAtNotNewerThan(capturedAt));
    expect(q.sql).toContain('::timestamptz');
    // Exactly one bound parameter, and it is the ISO string — not a Date.
    expect(q.params).toEqual(['2026-08-27T01:01:29.468Z']);
    expect(typeof q.params[0]).toBe('string');
  });

  test('the bound parameter is never a JS Date locale string', () => {
    const q = new PgDialect().sqlToQuery(capturedAtNotNewerThan(capturedAt));
    for (const p of q.params) {
      expect(p).not.toBeInstanceOf(Date);
      expect(String(p)).not.toMatch(/GMT|Central European|[A-Z][a-z]{2} [A-Z][a-z]{2} \d/);
    }
  });
});
