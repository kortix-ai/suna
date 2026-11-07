#!/usr/bin/env bun
/**
 * Recover the conversations of old OpenCode sessions that never reached the
 * session log.
 *
 * WHY. The session log (`session_logs*`) is the only transcript store since
 * 2026-10-30. The backfill that filled it read the API's old copy
 * (`session_transcript_messages`), and that copy missed whole classes of
 * sessions: before 2026-08-26 it did not exist; until 2026-09-28 it was an
 * experimental flag, off by default, so a session got a copy mostly when a
 * person opened it; until 2026-09-29 a session another session's agent created
 * saved nothing at turn end (#8177). Those conversations exist only in OpenCode's
 * own store (`opencode.db`) on each session's archived box, and since #11155
 * nothing reads that store: a woken box boots pi on an empty log.
 *
 * WHAT. For each candidate session (not deleted, no session log, a turn on
 * record, an OpenCode root, a parked Platinum box): boot the box at Platinum
 * without Kortix (no billing, no turn, no sidebar change), copy the store out,
 * stop and re-archive the box, convert the store with the deleted kortixd
 * exporter's mapping (`fromV1`), and write it as the session's log at
 * generation 0. The next wake restores it into pi.
 *
 * Run it where the data already lives (an ECS task of the environment), never
 * on a laptop:
 *
 *   bun src/scripts/recover-opencode-history.ts --env prod --plan
 *   bun src/scripts/recover-opencode-history.ts --env prod --limit 5            # dry run: read + convert + validate, write nothing
 *   bun src/scripts/recover-opencode-history.ts --env prod --limit 5 --apply
 *   bun src/scripts/recover-opencode-history.ts --env prod --apply              # everything, in batches
 *   ... [--provider platinum|daytona] [--session <id>]… [--project <id>] [--concurrency 3]
 *
 * BIG STORES. A store over 128 MiB is set aside (`too_large`, with its size) and
 * not copied. A second run takes them one at a time, on a task with more memory:
 *
 *   bun src/scripts/recover-opencode-history.ts --env prod --apply --max-store-mb 2048 --concurrency 1
 *
 * STOP RULES (the run ends by itself and exits 1): 5 failures in a row; more
 * than 2 invalid logs and over 5 % of the processed sessions; Platinum
 * throttling (429) for over 5 minutes; SIGTERM (in-flight boxes finish first).
 *
 * PRIVACY. Copies live in a temp folder deleted after each session. The log
 * prints ids and counts, never a title, a prompt or a file name.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { recoverSessionLog, sidecarPaths } from './recover-opencode-history/convert';
import { readOpenCodeStore, UnsupportedStoreError } from './recover-opencode-history/opencode-store';
import { MAX_STORE_BYTES, RecoverableBoxError, type BoxReader } from './recover-opencode-history/box';
import { daytonaBox } from './recover-opencode-history/daytona-box';
import { platinumBox } from './recover-opencode-history/platinum-box';
import { RECOVERY_KEY, rowParked, stamp, stillRecoverable, writeRecoveredLog, type RecoveryStamp } from './recover-opencode-history/write';

const BATCH = 200;
/** Caps on a tenant-written store, checked before the conversion (fromV1 is quadratic in sessions). */
const MAX_STORE_SESSIONS = 500;
const MAX_STORE_MESSAGES = 50_000;
const MAX_STORE_PARTS = 500_000;
const MAX_SIDECARS = 500;
const MAX_ATTEMPTS = 3;
const CONSECUTIVE_FAILURES_STOP = 5;
const THROTTLE_STOP_MS = 5 * 60_000;

interface Args {
  env: string;
  plan: boolean;
  apply: boolean;
  limit: number | null;
  sessions: string[];
  project: string | null;
  concurrency: number;
  provider: 'platinum' | 'daytona';
  maxStoreBytes: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { env: '', plan: false, apply: false, limit: null, sessions: [], project: null, concurrency: 3, provider: 'platinum', maxStoreBytes: MAX_STORE_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') out.env = argv[++i] ?? '';
    else if (a === '--plan') out.plan = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--session') out.sessions.push(argv[++i] ?? '');
    else if (a === '--project') out.project = argv[++i] ?? null;
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--max-store-mb') out.maxStoreBytes = Number(argv[++i]) * 1024 * 1024;
    else if (a === '--provider') {
      const p = argv[++i];
      if (p !== 'platinum' && p !== 'daytona') throw new Error('--provider must be platinum or daytona');
      out.provider = p;
    }
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.limit !== null && !(out.limit > 0)) throw new Error('--limit must be a positive number');
  if (!(out.concurrency >= 1 && out.concurrency <= 6)) throw new Error('--concurrency must be 1..6');
  if (!(Number.isSafeInteger(out.maxStoreBytes) && out.maxStoreBytes > 0 && out.maxStoreBytes <= 4096 * 1024 * 1024)) {
    throw new Error('--max-store-mb must be a whole number, 1..4096');
  }
  // Memory: the conversion holds a store several times over.
  if (out.maxStoreBytes > MAX_STORE_BYTES && out.concurrency !== 1) throw new Error('--max-store-mb above 128 needs --concurrency 1');
  // A dry run stamps nothing, so without a limit it would read the same boxes again and again.
  if (!out.apply && !out.plan && out.limit === null) out.limit = 5;
  return out;
}

type Candidate = {
  session_id: string;
  project_id: string;
  account_id: string;
  root: string | null;
  origin: string;
  sandbox_id: string;
  external_id: string;
  attempts: number;
};

/**
 * A raised cap takes again the sessions set aside for their store size (no
 * recorded size, or one under the cap), not those over the row caps (their
 * detail starts with `sessions=`).
 */
function retakeTooLarge(maxStoreBytes: number) {
  return sql`OR (ss.metadata->${RECOVERY_KEY}->>'outcome' = 'too_large'
            AND coalesce(ss.metadata->${RECOVERY_KEY}->>'detail', '') NOT LIKE 'sessions=%'
            AND coalesce((ss.metadata->${RECOVERY_KEY}->>'bytes')::bigint, 0) <= ${maxStoreBytes})`;
}

/** Sessions whose only transcript is an OpenCode store on a parked box of `--provider`. Fresh ones first, then retries. */
function candidateFilter(args: Args) {
  return sql`
    FROM kortix.project_sessions ps
    JOIN kortix.projects p ON p.project_id = ps.project_id
    JOIN kortix.session_sandboxes ss ON ss.session_id = ps.session_id
    WHERE NOT EXISTS (SELECT 1 FROM kortix.session_logs l WHERE l.session_id = ps.session_id)
      AND NOT ps.metadata ? 'deletedAt'
      AND ss.provider = ${args.provider}::kortix.sandbox_provider
      AND ss.external_id IS NOT NULL
      AND ss.status IN ('stopped', 'error')
      AND coalesce(ss.metadata->>'runtimeIdentityState', '') <> 'unavailable'
      AND NOT ss.metadata ?| array['runtimeWakeId', 'runtimeRestartId', 'runtimeRecoveryLeaseId']
      AND (ps.runtime_session_id IS NULL OR ps.runtime_session_id NOT LIKE 'ses_pi%')
      AND (ss.metadata ? 'lastTurnAt' OR EXISTS (SELECT 1 FROM kortix.session_turns t WHERE t.session_id = ps.session_id))
      AND NOT EXISTS (
        SELECT 1 FROM kortix.account_deletion_requests d
        WHERE d.account_id = ps.account_id AND d.status IN ('pending', 'processing')
      )
      AND (
        NOT ss.metadata ? ${RECOVERY_KEY}
        OR (ss.metadata->${RECOVERY_KEY}->>'outcome' = 'retry'
            AND coalesce((ss.metadata->${RECOVERY_KEY}->>'attempts')::int, 0) < ${MAX_ATTEMPTS})
        ${args.maxStoreBytes > MAX_STORE_BYTES ? retakeTooLarge(args.maxStoreBytes) : sql``}
      )
      ${args.sessions.length ? sql`AND ps.session_id IN (${sql.join(args.sessions.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${args.project ? sql`AND ps.project_id = ${args.project}::uuid` : sql``}`;
}

async function candidates(args: Args, limit: number, exclude: Set<string>): Promise<Candidate[]> {
  const rows = await db.execute<Candidate>(sql`
    SELECT ps.session_id, ps.project_id::text, ps.account_id::text, ps.runtime_session_id AS root, ps.origin::text,
           ss.sandbox_id::text, ss.external_id,
           coalesce((ss.metadata->${RECOVERY_KEY}->>'attempts')::int, 0) AS attempts
    ${candidateFilter(args)}
    ORDER BY (ss.metadata ? ${RECOVERY_KEY}), (ps.origin = 'user') DESC, (p.status = 'active') DESC, ps.created_at DESC
    LIMIT ${limit + exclude.size}`);
  return [...rows].filter((r) => !exclude.has(r.session_id)).slice(0, limit);
}

async function plan(args: Args): Promise<void> {
  const [row] = await db.execute<Record<string, number>>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ps.origin = 'user')::int AS by_user,
           count(*) FILTER (WHERE p.status = 'active')::int AS active_projects,
           count(*) FILTER (WHERE ss.metadata ? ${RECOVERY_KEY})::int AS retries,
           count(*) FILTER (WHERE ps.runtime_session_id IS NULL)::int AS no_root
    ${candidateFilter(args)}`);
  const done = await db.execute<{ outcome: string; n: number }>(sql`
    SELECT ss.metadata->${RECOVERY_KEY}->>'outcome' AS outcome, count(*)::int AS n
    FROM kortix.session_sandboxes ss WHERE ss.metadata ? ${RECOVERY_KEY} GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`[plan] candidates ${JSON.stringify(row)}`);
  console.log(`[plan] recorded outcomes ${JSON.stringify(Object.fromEntries([...done].map((d) => [d.outcome, d.n])))}`);
}

interface Result {
  outcome: string;
  retryable?: boolean;
  /**
   * False when the box was not ours to read yet (running, or still archiving
   * after an earlier cycle): no attempt is spent and the stop rules ignore it.
   */
  attempted?: false;
  detail?: string;
  messages?: number;
  threads?: number;
  blobs?: number;
  bytes?: number;
}

/** One session, end to end. Never throws: every failure is a result. */
async function recoverOne(box: BoxReader, c: Candidate, args: Pick<Args, 'apply' | 'maxStoreBytes'>): Promise<Result> {
  const { apply } = args;
  const local = await mkdtemp(join(tmpdir(), 'kortix-recover-'));
  let started = false;
  let result: Result;
  try {
    const state = await box.state(c.external_id);
    if (state === 'gone') return { outcome: 'box_gone' };
    if (state === 'running' || state === 'other') return { outcome: 'retry', retryable: true, attempted: false, detail: `box ${state}` };
    if (!(await stillRecoverable(c.session_id))) return { outcome: 'skipped', detail: 'session changed before the read' };
    started = true;
    const copied = await box.copyStore(c.external_id, join(local, 'store'), args.maxStoreBytes);
    if (copied.kind === 'none') {
      result = { outcome: 'no_store' };
    } else if (copied.kind === 'too_large') {
      result = { outcome: 'too_large', bytes: copied.bytes };
    } else {
      const store = readOpenCodeStore(copied.dbPath);
      const paths = sidecarPaths(store);
      // The store is tenant-written: bound what the conversion walks before it walks it.
      const over = store.sessions.length > MAX_STORE_SESSIONS || store.messages.length > MAX_STORE_MESSAGES || store.parts.length > MAX_STORE_PARTS || paths.length > MAX_SIDECARS;
      if (over) {
        result = { outcome: 'too_large', detail: `sessions=${store.sessions.length} messages=${store.messages.length} parts=${store.parts.length} sidecars=${paths.length}`, bytes: copied.bytes };
      } else {
      const sidecars = await box.copySidecars(c.external_id, paths, join(local, 'sidecars'));
      const rootId = c.root ?? copied.pinnedRoot;
      const { log, blobs, messages } = recoverSessionLog({ sessionId: c.session_id, rootId, store, sidecars });
      const counts = { messages, threads: log.threads.length, blobs: blobs.size, bytes: copied.bytes };
      // `fromV1` merges every root into the session's thread, so 0 means no row parsed:
      // an empty store, or rows in a format the reader does not know.
      if (messages === 0 && store.messages.length > 0) {
        result = { outcome: 'unsupported_store', detail: `${store.messages.length} message rows, none parsed`, ...counts };
      } else if (messages === 0) result = { outcome: 'empty_store', detail: 'store_messages=0', ...counts };
      else if (!apply) result = { outcome: 'converted', ...counts };
      else {
        const written = await writeRecoveredLog({ sessionId: c.session_id, projectId: c.project_id, accountId: c.account_id }, log, blobs);
        result = { outcome: written.outcome, detail: written.detail, ...counts };
      }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : String(err);
    if (err instanceof UnsupportedStoreError) result = { outcome: 'unsupported_store', detail: message };
    else result = { outcome: 'retry', retryable: err instanceof RecoverableBoxError ? err.retryable : true, detail: message };
  } finally {
    await rm(local, { recursive: true, force: true });
  }
  if (started) {
    try {
      const back = await box.release(c.external_id, () => rowParked(c.session_id));
      if (back === 'left-running') result.detail = [result.detail, 'box left running: the session woke'].filter(Boolean).join('; ');
    } catch (err) {
      result.detail = [result.detail, `release failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`].filter(Boolean).join('; ');
      if (result.outcome !== 'written') result = { ...result, outcome: 'retry', retryable: true };
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.env || args.env !== config.INTERNAL_KORTIX_ENV) {
    throw new Error(`--env ${args.env || '(missing)'} does not match the loaded environment (${config.INTERNAL_KORTIX_ENV})`);
  }
  await plan(args);
  if (args.plan) return;
  const box = args.provider === 'daytona' ? daytonaBox : platinumBox;

  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
    console.log('[recover] SIGTERM: finishing the boxes in flight');
  });
  const totals = new Map<string, number>();
  const seen = new Set<string>();
  let processed = 0;
  let failuresInRow = 0;
  let invalid = 0;
  let stopReason: string | null = null;
  const startedAt = Date.now();

  for (;;) {
    const room = args.limit === null ? BATCH : Math.min(BATCH, args.limit - processed);
    if (room <= 0 || stopping || stopReason) break;
    const batch = await candidates(args, room, seen);
    if (batch.length === 0) break;
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (stopping || stopReason) return;
        const c = batch[next++];
        if (!c) return;
        seen.add(c.session_id);
        const t0 = Date.now();
        const r = await recoverOne(box, c, args);
        processed++;
        totals.set(r.outcome, (totals.get(r.outcome) ?? 0) + 1);
        console.log(
          `[recover] ${r.outcome} session=${c.session_id} box=${c.external_id} origin=${c.origin}` +
            ` messages=${r.messages ?? '-'} threads=${r.threads ?? '-'} blobs=${r.blobs ?? '-'} bytes=${r.bytes ?? '-'} ms=${Date.now() - t0}` +
            ` rss_mb=${Math.round(process.memoryUsage().rss / 2 ** 20)}` +
            (r.detail ? ` detail=${JSON.stringify(r.detail)}` : ''),
        );
        if (args.apply) {
          const value: RecoveryStamp = {
            at: new Date().toISOString(),
            // A skip means the session changed under the recovery (someone opened it): look again
            // next run. A session that has a log by then is no longer a candidate.
            outcome: r.outcome === 'retry' && !r.retryable ? 'failed' : r.outcome === 'skipped' ? 'retry' : r.outcome,
            attempts: c.attempts + (r.attempted === false ? 0 : 1),
            ...(r.detail && { detail: r.detail.slice(0, 300) }),
            ...(r.messages !== undefined && { messages: r.messages, threads: r.threads }),
            ...(r.bytes !== undefined && { bytes: r.bytes }),
          };
          await stamp(c.sandbox_id, value).catch((err) => console.log(`[recover] stamp failed session=${c.session_id}: ${String(err)}`));
        }
        if (r.attempted !== false) failuresInRow = r.outcome === 'retry' || r.outcome === 'refused' ? failuresInRow + 1 : 0;
        if (r.outcome === 'invalid') invalid++;
        if (failuresInRow >= CONSECUTIVE_FAILURES_STOP) stopReason = `${failuresInRow} failures in a row`;
        else if (invalid > 2 && invalid / processed > 0.05) stopReason = `${invalid} invalid logs of ${processed}`;
        else if (box.throttledForMs() > THROTTLE_STOP_MS) stopReason = `${args.provider} throttled for over 5 minutes`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(args.concurrency, batch.length) }, worker));
    if (!args.apply) break; // a dry run reads one batch
  }

  console.log(
    `[recover] done provider=${args.provider} mode=${args.apply ? 'apply' : 'dry-run'} max_store_mb=${args.maxStoreBytes / 2 ** 20} processed=${processed} minutes=${((Date.now() - startedAt) / 60_000).toFixed(1)}` +
      ` outcomes=${JSON.stringify(Object.fromEntries(totals))}${stopReason ? ` STOPPED: ${stopReason}` : ''}`,
  );
  if (stopReason) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[recover] fatal', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
