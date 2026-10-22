/**
 * The pending_questions_close_stale backfill on a migrated PostgreSQL: an open
 * stored question closes when the KRTX-1739 rules say its wait ended, and
 * stays open otherwise. Synthetic fixtures only. Runs the migration's own
 * `up()` twice to prove it is idempotent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20261013195005605_pending_questions_close_stale.concurrent.ts',
);

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SANDBOX = crypto.randomUUID();
const RUN = crypto.randomUUID().slice(0, 8);
const session = (name: string) => `close-stale-${RUN}-${name}`;

// Every case is its own session: the turn that asked, then the question.
type Turn = { state: string; endReason?: string; endError?: string; startedHoursAgo: number };
const CASES: Record<string, { turns: Turn[]; askedHoursAgo: number; closes: boolean }> = {
  laterTurn: {
    turns: [
      { state: 'ended', endReason: 'failed', endError: 'TurnAwaitingInput', startedHoursAgo: 72 },
      { state: 'ended', endReason: 'completed', startedHoursAgo: 24 },
    ],
    askedHoursAgo: 48,
    closes: true,
  },
  idle: { turns: [{ state: 'ended', endReason: 'completed', startedHoursAgo: 3 }], askedHoursAgo: 2, closes: true },
  userStop: {
    turns: [{ state: 'ended', endReason: 'failed', endError: 'UserStop', startedHoursAgo: 3 }],
    askedHoursAgo: 2,
    closes: true,
  },
  aborted: {
    turns: [{ state: 'ended', endReason: 'failed', endError: 'MessageAbortedError', startedHoursAgo: 3 }],
    askedHoursAgo: 2,
    closes: true,
  },
  parked: {
    turns: [{ state: 'ended', endReason: 'failed', endError: 'TurnAwaitingInput', startedHoursAgo: 3 }],
    askedHoursAgo: 2,
    closes: false,
  },
  live: { turns: [{ state: 'active', startedHoursAgo: 3 }], askedHoursAgo: 2, closes: false },
  runtimeGone: {
    turns: [{ state: 'ended', endReason: 'runtime_gone', startedHoursAgo: 3 }],
    askedHoursAgo: 2,
    closes: false,
  },
  boxStopped: {
    turns: [{ state: 'ended', endReason: 'failed', endError: 'SandboxStoppedMidTurn', startedHoursAgo: 3 }],
    askedHoursAgo: 2,
    closes: false,
  },
  noTurn: { turns: [], askedHoursAgo: 1500, closes: false },
};

let client: pg.Client;

async function runBackfill() {
  const migration = (await import(migrationPath)) as { up: (pgm: unknown) => Promise<void> };
  await migration.up({
    noTransaction: () => undefined,
    sql: () => undefined,
    db: { query: (text: string) => client.query(text) },
  });
}

async function insertTurn(sessionId: string, token: string, turn: Turn) {
  await client.query(
    `insert into kortix.session_turns
       (turn_token, session_id, sandbox_id, project_id, account_id, state, end_reason, end_error, started_at, ended_at)
     values ($1, $2, $3, $4, $5, $6::text, $7, $8::jsonb,
             now() - make_interval(hours => $9::int),
             case when $6::text = 'ended' then now() - make_interval(hours => $9::int) + interval '30 minutes' end)`,
    [
      token,
      sessionId,
      SANDBOX,
      PROJECT,
      ACCOUNT,
      turn.state,
      turn.endReason ?? null,
      turn.endError ? JSON.stringify({ name: turn.endError, message: null }) : null,
      turn.startedHoursAgo,
    ],
  );
}

async function insertQuestion(sessionId: string, requestId: string, askedHoursAgo: number) {
  await client.query(
    `insert into kortix.session_pending_questions
       (account_id, project_id, session_id, request_id, questions, asked_at)
     values ($1, $2, $3, $4, '[]'::jsonb, now() - make_interval(hours => $5))`,
    [ACCOUNT, PROJECT, sessionId, requestId, askedHoursAgo],
  );
}

async function questionsOf(sessionId: string) {
  const { rows } = await client.query(
    `select request_id, answered_at, answers, updated_at
       from kortix.session_pending_questions where session_id = $1 order by request_id`,
    [sessionId],
  );
  return rows;
}

describe.skipIf(!databaseUrl)('pending_questions_close_stale backfill — migrated PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    for (const [name, c] of Object.entries(CASES)) {
      for (const [i, turn] of c.turns.entries()) await insertTurn(session(name), `${session(name)}-t${i}`, turn);
      await insertQuestion(session(name), 'q1', c.askedHoursAgo);
    }

    // One session, two questions: the first was asked before the live turn
    // started (a delivered prompt closes it), the second during that turn.
    await insertTurn(session('mixed'), `${session('mixed')}-t0`, { state: 'ended', endReason: 'failed', endError: 'TurnAwaitingInput', startedHoursAgo: 10 });
    await insertQuestion(session('mixed'), 'q1', 9);
    await insertTurn(session('mixed'), `${session('mixed')}-t1`, { state: 'active', startedHoursAgo: 2 });
    await insertQuestion(session('mixed'), 'q2', 1);

    // An answered question keeps its answer and its timestamp.
    await insertTurn(session('answered'), `${session('answered')}-t0`, { state: 'ended', endReason: 'completed', startedHoursAgo: 5 });
    await insertQuestion(session('answered'), 'q1', 6);
    await client.query(
      `update kortix.session_pending_questions
          set answered_at = now() - interval '5 hours', answers = '[["yes"]]'::jsonb
        where session_id = $1`,
      [session('answered')],
    );

    // More stale rows than one batch holds: the loop runs until a batch is empty.
    await insertTurn(session('bulk'), `${session('bulk')}-t0`, { state: 'ended', endReason: 'completed', startedHoursAgo: 1 });
    await client.query(
      `insert into kortix.session_pending_questions (account_id, project_id, session_id, request_id, questions, asked_at)
       select $1, $2, $3, 'bulk-' || n, '[]'::jsonb, now() - interval '2 hours' from generate_series(1, 1203) n`,
      [ACCOUNT, PROJECT, session('bulk')],
    );

    await runBackfill();
  });

  afterAll(async () => {
    await client.query(`delete from kortix.session_pending_questions where account_id = $1`, [ACCOUNT]);
    await client.query(`delete from kortix.session_turns where account_id = $1`, [ACCOUNT]);
    await client.end();
  });

  for (const [name, c] of Object.entries(CASES)) {
    test(`${name}: the question ${c.closes ? 'closes' : 'stays open'}`, async () => {
      const [row] = await questionsOf(session(name));
      if (c.closes) {
        expect(row.answered_at).not.toBeNull();
        expect(row.answers).toBeNull();
      } else {
        expect(row.answered_at).toBeNull();
      }
    });
  }

  test('a question asked before a later turn closes; one asked during the live turn stays open', async () => {
    const [q1, q2] = await questionsOf(session('mixed'));
    expect(q1.answered_at).not.toBeNull();
    expect(q2.answered_at).toBeNull();
  });

  test('an answered question keeps its answer and its answered_at', async () => {
    const [row] = await questionsOf(session('answered'));
    expect(row.answers).toEqual([['yes']]);
    const { rows } = await client.query(
      `select answered_at < now() - interval '4 hours' as kept from kortix.session_pending_questions where session_id = $1`,
      [session('answered')],
    );
    expect(rows[0].kept).toBe(true);
  });

  test('more rows than one batch all close', async () => {
    const { rows } = await client.query(
      `select count(*) filter (where answered_at is null)::int as open, count(*)::int as total
         from kortix.session_pending_questions where session_id = $1`,
      [session('bulk')],
    );
    expect(rows[0]).toEqual({ open: 0, total: 1203 });
  });

  test('a second run changes nothing', async () => {
    const before = await client.query(
      `select id, answered_at, updated_at from kortix.session_pending_questions where account_id = $1 order by id`,
      [ACCOUNT],
    );
    await runBackfill();
    const after = await client.query(
      `select id, answered_at, updated_at from kortix.session_pending_questions where account_id = $1 order by id`,
      [ACCOUNT],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
