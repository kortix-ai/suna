// Migration: gateway_logs_llm_value_backfill  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: idempotent passes, each a loop of short committed statements.
// Bound measured read-only against prod (2026-11-04): only rows written since
// the gateway started writing the two metadata keys are touched —
// `usageEstimated` since KRTX-3560 (2026-10-27, ~8 days of rows),
// `servedModel` since the served-model trace landed. Every row a pass touches
// leaves its selection predicate (the column becomes non-NULL), so each loop
// ends when a batch changes nothing.
//
// KRTX-4023, step 2 of the promotion. Fills the columns
// 20261104054916390_gateway_logs_served_model_usage_estimated.sql added, from
// the metadata keys the gateway writer has always carried:
//
//   served_model    <- metadata->>'servedModel'   (hooks.ts persistGatewayTrace)
//   usage_estimated <- metadata->>'usageEstimated' = 'true'
//                     (simple-handler.ts emit: `estimated || !reported`)
//
// Rows without the keys keep NULL: the readers treat a NULL column exactly as
// a missing metadata key (session-model-usage.ts falls back to
// requested/resolved_model; llm-value.ts coalesces the flag to false) — the
// pre-promotion behavior, so NULL is always a correct final state. Keys whose
// jsonb value is null are also skipped (they read NULL, same final state), so
// every pass's predicate strictly shrinks.
//
// Readers keep reading metadata until this pass ran: migrations run before the
// new pods start, so by the time the column-reading code serves traffic, this
// pass has healed every row the OLD writer produced. Rows the old writer
// produces during the deploy window (after the last batch, before the new
// pods' first write) are the only residual: the statement is idempotent and
// re-runnable — re-run it once after the deploy settles if exactness matters
// for that window (a one-line ops step, no lock held between batches).

export const shorthands = undefined;

const BATCH = 5000;
// A bound, not an expectation: every pass shrinks its own selection.
const MAX_BATCHES = 10000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the passes below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  const loop = async (statement) => {
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const { rowCount } = await pgm.db.query(statement);
      if (!rowCount) return;
    }
    throw new Error('gateway_logs_llm_value_backfill: batch bound reached');
  };

  // Row locks only, 5s budget: writers never queue behind a batch. Each batch
  // is its own committed transaction, so the pass is resumable and keeps the
  // table writable throughout.
  await loop(`
    update kortix.gateway_request_logs
       set served_model = metadata->>'servedModel',
           usage_estimated = (metadata->>'usageEstimated') = 'true'
     where log_id in (
       select log_id
         from kortix.gateway_request_logs
        where (served_model is null and metadata ? 'servedModel'
               and metadata->>'servedModel' is not null)
           or (usage_estimated is null and metadata ? 'usageEstimated'
               and metadata->>'usageEstimated' is not null)
        limit ${BATCH}
     )
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
