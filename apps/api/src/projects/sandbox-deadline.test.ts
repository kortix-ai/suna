import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mockConfigModule } from './reaping/test-support/mock-config';

// The module only ever issues raw SQL, so the assertions below are about the
// STATEMENT SHAPE — which is the whole safety argument: an extend must contain
// both LEAST (the cap) and GREATEST (monotonicity), a shorten must contain
// LEAST and never GREATEST, and neither may assign active_since.
let executed: string[] = [];
/** What the mocked driver returns from `db.execute`. `undefined` reproduces a
 *  driver response returned by `db.execute`. */
let executeResult: unknown;
let executeThrows: Error | null = null;

/** Flatten a drizzle SQL tree — literal chunks, bound params, and nested
 *  fragments — into text, so a test can assert what Postgres is actually asked
 *  to do rather than trusting the TypeScript that assembled it. */
function render(query: unknown): string {
  if (query === null || query === undefined) return '';
  // Interpolated primitives are stored raw by drizzle, not wrapped in Param.
  if (typeof query !== 'object') return String(query);
  const node = query as {
    queryChunks?: unknown[];
    value?: unknown;
    name?: unknown;
  };
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(render).join(' ');
  if (Array.isArray(node.value)) return node.value.join('');
  if (node.value !== undefined) return String(node.value);
  if (node.name !== undefined) return String(node.name);
  return '';
}

/** Collapse the rendered statement's whitespace so an assertion can be about
 *  the EXPRESSION SHAPE without depending on how drizzle spaced the chunks. */
const squish = (sql: string) => sql.replace(/\s+/g, ' ');

mock.module('../config', () => mockConfigModule());
mock.module('../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      executed.push(render(query));
      if (executeThrows) throw executeThrows;
      return executeResult;
    },
  }, auditDb: {
    execute: async (query: unknown) => {
      executed.push(render(query));
      if (executeThrows) throw executeThrows;
      return executeResult;
    },
  },
}));

const {
  NON_TURN_DEADLINE_CAP_MS,
  extendSandboxDeadline,
  extendUnconfirmedTurnDeadline,
  grantWarmPoolLifetime,
  idleGraceMs,
  isSandboxAuthored,
  isTurnStartRequest,
  shortenSandboxDeadline,
  shortenSandboxDeadlineOnTurnEnd,
  turnGrantMs,
  turnUnconfirmedDripMs,
} = await import('./sandbox-deadline');

beforeEach(() => {
  executed = [];
  executeResult = undefined;
  executeThrows = null;
  delete process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES;
  delete process.env.KORTIX_SANDBOX_WARM_GRANT_MINUTES;
  delete process.env.KORTIX_SANDBOX_TURN_UNCONFIRMED_DRIP_MINUTES;
});

describe('the constants', () => {
  test('the generous ceiling is 4h by default — above p99, below the 264h worst case', () => {
    expect(turnGrantMs()).toBe(4 * 3_600_000);
  });

  test('the idle grace reuses KORTIX_SANDBOX_AUTOSTOP_MINUTES, already 15 in prod', () => {
    expect(idleGraceMs()).toBe(15 * 60_000);
  });

  test('non-turn observations are capped at 24h', () => {
    expect(NON_TURN_DEADLINE_CAP_MS).toBe(24 * 3_600_000);
  });

  test('the grant is tunable, so it can be tightened without a code change', () => {
    process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES = '60';
    expect(turnGrantMs()).toBe(60 * 60_000);
  });

  test('an absurd non-turn grant still clamps to the cap', () => {
    process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES = '100000';
    expect(turnGrantMs()).toBeGreaterThan(NON_TURN_DEADLINE_CAP_MS);
  });
});

describe('extendSandboxDeadline — control-plane-observed, monotone, capped', () => {
  test('clamps to active_since + the cap AND never moves the deadline backwards', async () => {
    await extendSandboxDeadline({ sessionId: 'sess-1' });

    const [sql] = executed;
    expect(sql).toContain('LEAST'); // the cap
    expect(sql).toContain('GREATEST'); // monotonic: a concurrent extend can't be lost
    expect(sql).toContain('active_since +');
    expect(sql).toContain('86400'); // NON_TURN_DEADLINE_CAP_MS in seconds
    expect(sql).toContain('14400'); // the 4h grant in seconds
  });

  // ═══ THE MID-TURN KILL THIS CLOSES ═══
  // The expression used to be LEAST(active_since + 24h, GREATEST(deadline_at,
  // now() + grant)), which SHORTENS the deadline of any box whose provider run
  // is already past the anchor cap. Active-turn renewal is deliberately uncapped
  // (sandbox-turn-lifecycle.ts) and migration 20260817150000000 dropped the
  // `session_sandboxes_deadline_within_cap` CHECK precisely so an observed turn
  // may outlive 24h — so on a 30h-old box holding a turn renewed to now + 4h,
  // any extend rewrote deadline_at to a value ~6h IN THE PAST and the next
  // reaper pass parked the box mid-turn. An "extend" may never contract.
  test('REGRESSION: GREATEST-first, so no extend can ever move a deadline backwards', async () => {
    await extendSandboxDeadline({ sessionId: 'sess-1' });

    // The shape IS the proof: GREATEST(s.deadline_at, X) >= s.deadline_at for
    // every X, whatever the anchor says. The cap lives INSIDE it, so it still
    // bounds what THIS observation may grant without contracting what an
    // uncapped active-turn renewal already granted.
    expect(squish(executed[0])).toMatch(
      /deadline_at = GREATEST\( ?s\.deadline_at, LEAST\( ?s\.active_since \+ make_interval/,
    );
  });

  test('NEVER assigns active_since — the DB trigger owns the anchor', async () => {
    await extendSandboxDeadline({ sessionId: 'sess-1' });

    expect(executed[0]).not.toMatch(/SET[\s\S]*active_since\s*=/);
  });

  // Times are computed by Postgres from intervals, so API-pod clock skew cannot
  // reach the money path and the write stays a single monotone statement.
  test('passes the grant as an INTERVAL against SQL now(), not a computed instant', async () => {
    await extendSandboxDeadline({ sessionId: 'sess-1' });

    expect(executed[0]).toContain('make_interval');
    expect(executed[0]).toContain('now()');
  });

  test('only ever touches a live box', async () => {
    await extendSandboxDeadline({ sessionId: 'sess-1' });

    expect(executed[0]).toContain("status IN ('active', 'provisioning')");
  });

  test('addresses a box by sandbox id, session id, or external id', async () => {
    await extendSandboxDeadline({ sandboxId: 'sb-1' });
    await extendSandboxDeadline({ sessionId: 'sess-1' });
    await extendSandboxDeadline({ externalId: 'ext-1' });

    expect(executed[0]).toContain('sandbox_id');
    expect(executed[1]).toContain('session_id');
    expect(executed[2]).toContain('external_id');
  });
});

// ═══ THE FEATURE-DEFEATING BUG THIS CLOSES ═══
// The warm exemption was deleted with no replacement. An unclaimed warm box has
// no turns, no LLM calls and no human traffic, so it can NEVER receive an extend
// — every warm box was reaped at its 15-minute boot floor before it could be
// handed out, which defeats the warm pool outright.
describe('grantWarmPoolLifetime — the one box that can never be observed', () => {
  test('REGRESSION: a warm box is granted its bounded hour at bake time', async () => {
    await grantWarmPoolLifetime('sb-1', {
      warm_session: { state: 'available', sandbox_slug: 'default' },
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('3600'); // 60 minutes, in seconds
    expect(executed[0]).toContain('GREATEST'); // still monotone
    expect(executed[0]).toContain('86400'); // still under the same 24h cap
  });

  test('an ordinary box is untouched — no extra write on the provision hot path', async () => {
    await grantWarmPoolLifetime('sb-1', { session_id: 'sess-1' });
    await grantWarmPoolLifetime('sb-1', null);
    await grantWarmPoolLifetime('sb-1', { warm_session: { state: 'claimed' } });

    expect(executed).toEqual([]);
  });

  test('the warm lifetime is tunable', async () => {
    process.env.KORTIX_SANDBOX_WARM_GRANT_MINUTES = '10';
    await grantWarmPoolLifetime('sb-1', {
      warm_session: { state: 'available' },
    });

    expect(executed[0]).toContain('600');
  });

  test('a failed grant never fails the provision', async () => {
    executeThrows = new Error('db down');

    expect(
      await grantWarmPoolLifetime('sb-1', {
        warm_session: { state: 'available' },
      }),
    ).toBeUndefined();
  });
});

// ═══ THE MID-TURN STARVATION THIS CLOSES ═══
// Incident 2026-08-17T20:40:03Z (session 0fc6897a, Daytona f468056d): the box
// held a control-plane-minted turn record for its whole life and `deadlineGrant`
// never left `boot_floor`. The daemon on that warm snapshot answered the turn
// probe with nothing readable, so `observeSandboxTurn` never returned `active`,
// `renewActiveSandboxTurn` never ran, and the box died on the 15-minute resume
// floor WHILE ITS TURN WAS RUNNING. A renewal that starves must not be silent.
describe('extendUnconfirmedTurnDeadline — the bounded drip for a mute daemon', () => {
  test('is monotone, so a concurrent extend can never be lost', async () => {
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(squish(executed[0])).toMatch(
      /deadline_at = GREATEST\( ?s\.deadline_at, now\(\) \+ make_interval/,
    );
  });

  // ═══ THE SILENT NO-OP THIS CLOSES ═══
  // The drip shared `cappedDeadline` with the non-turn extend, so it read
  // GREATEST(deadline_at, LEAST(active_since + 24h, now + 15m)). `active_since`
  // is the IMMUTABLE anchor of the current provider run (migration
  // 20260817150000000), so on a box running longer than 24h the inner LEAST is
  // already in the PAST and the GREATEST returns deadline_at unchanged — the
  // drip did NOTHING for exactly the long-running mid-turn boxes it exists to
  // save, while still RETURNING true and stamping `deadlineGrant:
  // 'turn_unconfirmed'`, so the row and the log both claimed a box was being
  // kept alive whose deadline never moved.
  //
  // The anchor cap is a bound on NON-TURN observations. This box holds turn
  // authority the control plane minted, and `renewActiveSandboxTurn` — the same
  // evidence class, only stronger — is deliberately uncapped for that reason.
  // What bounds the drip is the caller's freshness gate (reaping/box-reaper.ts):
  // a record past its own state's bound stops earning horizons at all.
  test('REGRESSION: the anchor cap cannot turn the drip into a silent no-op', async () => {
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(executed[0]).not.toContain('active_since');
    expect(executed[0]).not.toContain('86400');
  });

  test('grants ONE liveness horizon, not a turn grant', async () => {
    // 15 minutes, so a genuinely dead runtime stops getting the drip within one
    // horizon of its turn record ageing out — never the 4-hour turn grant, which
    // an unreadable daemon has not earned.
    expect(turnUnconfirmedDripMs()).toBe(15 * 60_000);
    await extendUnconfirmedTurnDeadline('sb-1');
    expect(executed[0]).toContain('900');
    expect(executed[0]).not.toContain('14400');
  });

  test('stamps deadlineGrant, so a drip-fed box is visible in the row', async () => {
    // `deadlineGrant` is what the incident triage read first, and it said
    // `boot_floor` for a box that was being kept alive by nothing at all.
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(executed[0]).toContain('deadlineGrant');
    expect(executed[0]).toContain('turn_unconfirmed');
  });

  test('merges the stamp into jsonb — never assigns the metadata column', async () => {
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(executed[0]).toContain('coalesce');
    expect(executed[0]).toContain("'{}'::jsonb");
  });

  test('NEVER assigns active_since — the DB trigger owns the anchor', async () => {
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(executed[0]).not.toMatch(/SET[\s\S]*active_since\s*=/);
  });

  test('only ever touches a live box, addressed by sandbox id', async () => {
    await extendUnconfirmedTurnDeadline('sb-1');

    expect(executed[0]).toContain("status = 'active'");
    expect(executed[0]).toContain('sandbox_id');
    expect(executed[0]).toContain('sb-1');
  });

  test('the drip is tunable, so it can be tightened without a code change', async () => {
    process.env.KORTIX_SANDBOX_TURN_UNCONFIRMED_DRIP_MINUTES = '5';
    expect(turnUnconfirmedDripMs()).toBe(5 * 60_000);
    await extendUnconfirmedTurnDeadline('sb-1');
    expect(executed[0]).toContain('300');
  });

  test('reports whether it moved a row', async () => {
    executeResult = [{ extended: true }];
    expect(await extendUnconfirmedTurnDeadline('sb-1')).toBe(true);

    executeResult = [];
    expect(await extendUnconfirmedTurnDeadline('sb-1')).toBe(false);
  });

  test('a failed drip never fails the reaper pass', async () => {
    executeThrows = new Error('db down');
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await extendUnconfirmedTurnDeadline('sb-1')).toBe(false);
    } finally {
      console.warn = warn;
    }
  });
});

describe('shortenSandboxDeadline — sandbox-reported, structurally unable to extend', () => {
  // THE INVARIANT, mechanised: because the statement is LEAST-only, it does not
  // matter that the sandbox is the one reporting the turn end. It can be
  // best-effort, duplicated, and replayed without ever prolonging a box.
  test('is LEAST-only: no GREATEST, so it can never push a deadline out', async () => {
    await shortenSandboxDeadline('sess-1');

    expect(executed[0]).toContain('LEAST');
    expect(executed[0]).not.toContain('GREATEST');
  });

  test('does not read or write the anchor, and needs no cap', async () => {
    await shortenSandboxDeadline('sess-1');

    expect(executed[0]).not.toContain('active_since');
    expect(executed[0]).not.toContain('86400');
  });

  test('grants the 15-minute idle tail', async () => {
    await shortenSandboxDeadline('sess-1');

    expect(executed[0]).toContain('900'); // 15 min in seconds
  });
});

// ═══ THE MID-TURN KILL THIS CLOSES ═══
// `session.error` fires while opencode is RETRYING too. Shortening the box there
// cut it to the 15-minute idle tail WHILE THE TURN WAS STILL RUNNING, so any
// rate-limit backoff longer than 15 minutes killed live work. The classifier
// ships bound to the write so a future caller cannot re-wire one without the
// other.
describe('shortenSandboxDeadlineOnTurnEnd — a retry is not a turn end', () => {
  test('an idle turn end shortens the box to the idle tail', async () => {
    await shortenSandboxDeadlineOnTurnEnd('sess-1', 'idle');

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('900'); // 15 min in seconds
    expect(executed[0]).not.toContain('GREATEST'); // still LEAST-only
  });

  test('REGRESSION: a RETRYABLE error writes NOTHING — the turn is still running', async () => {
    await shortenSandboxDeadlineOnTurnEnd('sess-1', 'error', {
      isRetryable: true,
    });

    expect(executed).toEqual([]);
  });

  test('a permanent error shortens the box', async () => {
    await shortenSandboxDeadlineOnTurnEnd('sess-1', 'error', {
      isRetryable: false,
    });

    expect(executed).toHaveLength(1);
  });

  test('an error with no retry flag shortens — unknown is never assumed alive', async () => {
    await shortenSandboxDeadlineOnTurnEnd('sess-1', 'error');
    await shortenSandboxDeadlineOnTurnEnd('sess-1', 'error', undefined);

    expect(executed).toHaveLength(2);
  });
});

describe('isTurnStartRequest — what the control plane counts as OBSERVING a run', () => {
  const AGENT = 8000;
  const OPENCODE = 4096;

  test('every real prompt-delivery path on both ports', () => {
    for (const port of [AGENT, OPENCODE]) {
      expect(isTurnStartRequest(port, 'POST', '/session/abc/prompt_async')).toBe(true);
      expect(isTurnStartRequest(port, 'POST', '/session/abc/message')).toBe(true);
      // /command and /summarize start a real, billable turn too — a classifier
      // that admitted only prompt_async/message would kill a box mid-command.
      expect(isTurnStartRequest(port, 'POST', '/session/abc/command')).toBe(true);
      expect(isTurnStartRequest(port, 'POST', '/session/abc/summarize')).toBe(true);
    }
  });

  test('unwraps the in-box dynamic-port nesting', () => {
    expect(isTurnStartRequest(AGENT, 'POST', '/proxy/4096/session/abc/prompt_async')).toBe(true);
  });

  test('tolerates a query string or fragment on the boundary', () => {
    expect(
      isTurnStartRequest(AGENT, 'POST', '/session/abc/prompt_async?directory=/workspace'),
    ).toBe(true);
  });

  test('a GET never starts a turn — passive polling must not extend a box', () => {
    expect(isTurnStartRequest(AGENT, 'GET', '/session/abc/prompt_async')).toBe(false);
    expect(isTurnStartRequest(AGENT, 'GET', '/session/abc/message')).toBe(false);
  });

  test('an app port is not a turn start, whatever the path looks like', () => {
    expect(isTurnStartRequest(3000, 'POST', '/session/abc/prompt_async')).toBe(false);
  });

  test('read-only and lookalike paths are not turn starts', () => {
    expect(isTurnStartRequest(AGENT, 'POST', '/session/abc/status')).toBe(false);
    expect(isTurnStartRequest(AGENT, 'POST', '/session')).toBe(false);
    expect(isTurnStartRequest(AGENT, 'POST', '/session/abc/prompt_asyncx')).toBe(false);
  });
});

// The box holds TWO credentials that authenticate perfectly well. If either one
// is classified as a control-plane observation, the sandbox can renew its own
// deadline forever and the self-granted lease this design deletes is rebuilt.
describe('isSandboxAuthored — the box may never extend its own life', () => {
  test('the kortix_sb_ sandbox token is sandbox-authored', () => {
    expect(isSandboxAuthored('sandbox', null)).toBe(true);
  });

  test('a SESSION-SCOPED PAT is sandbox-authored even though apiKeyType is unset', () => {
    // `KORTIX_CLI_TOKEN`: injected into every box and used
    // by the in-box `kortix` CLI. Its auth branch never sets apiKeyType, so a
    // gate testing apiKeyType alone let the box hold itself open indefinitely.
    expect(isSandboxAuthored(undefined, 'session-abc')).toBe(true);
    expect(isSandboxAuthored(null, 'session-abc')).toBe(true);
    expect(isSandboxAuthored('user', 'session-abc')).toBe(true);
  });

  test('a real user credential is NOT sandbox-authored and may extend', () => {
    // Browser JWT and a non-session-bound personal PAT both resolve sessionId
    // to null, so a human prompting from the UI or their laptop CLI still
    // pushes the deadline out.
    expect(isSandboxAuthored(undefined, null)).toBe(false);
    expect(isSandboxAuthored('user', null)).toBe(false);
    expect(isSandboxAuthored(undefined, undefined)).toBe(false);
  });
});
