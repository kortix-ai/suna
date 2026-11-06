// Migration: session_metadata_runtime_keys  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: kortix.project_sessions rows whose `metadata` has an OpenCode-era
// key, 500 per batch. Bounds measured read-only on 2026-11-05 (rows with an old
// key / all rows): prod 48,383 / 80,083, dev 4,155 / 8,337. A renamed row loses
// every old key and leaves the selection, so the loop ends when a batch changes
// nothing.
//
// Every session runs pi, but the API still wrote these keys on new sessions.
// From this release it writes and reads only the new names:
//
//   opencode_model                      -> model
//   opencode_model_source               -> model_source
//   opencode_model_picked_at            -> model_picked_at
//   opencode_model_restored             -> model_restored
//   opencode_model_repointed_from       -> model_repointed_from
//   opencode_model_fallback_from        -> model_fallback_from
//   opencode_model_fallback_from_source -> model_fallback_from_source
//   opencode_model_fallback_reason      -> model_fallback_reason
//   opencode_model_fallback_at          -> model_fallback_at
//   opencode_model_fallback_until       -> model_fallback_until
//   opencode_sessions                   -> runtime_sessions
//
// No prod row had any new key before this migration (read-only check,
// 2026-11-05). A row that has both names got its old key from the previous
// API version during the rollout, after an earlier run of this pass: the old
// key is newer, so it wins (`order by` puts renamed keys last; jsonb keeps the
// last value of a duplicate key). The same pass is re-run once after the
// rollout for exactly that case. Values move unchanged, nested values included.
//
// Only `metadata` changes. `updated_at` stays. `status` stays, so the status
// audit trigger does not fire; the title trigger returns early (the title does
// not change). Row locks only; the house 5s lock budget keeps writers from
// queueing behind a batch.

export const shorthands = undefined;

const BATCH = 500;
// A bound, not an expectation: every batch shrinks its own selection.
const MAX_BATCHES = 10000;

const RENAMES = [
  ['opencode_model', 'model'],
  ['opencode_model_source', 'model_source'],
  ['opencode_model_picked_at', 'model_picked_at'],
  ['opencode_model_restored', 'model_restored'],
  ['opencode_model_repointed_from', 'model_repointed_from'],
  ['opencode_model_fallback_from', 'model_fallback_from'],
  ['opencode_model_fallback_from_source', 'model_fallback_from_source'],
  ['opencode_model_fallback_reason', 'model_fallback_reason'],
  ['opencode_model_fallback_at', 'model_fallback_at'],
  ['opencode_model_fallback_until', 'model_fallback_until'],
  ['opencode_sessions', 'runtime_sessions'],
];

const OLD_KEYS = `array[${RENAMES.map(([from]) => `'${from}'`).join(', ')}]::text[]`;
const RENAME_VALUES = RENAMES.map(([from, to]) => `('${from}', '${to}')`).join(', ');

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the batches below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      update kortix.project_sessions s
         set metadata = (
           select jsonb_object_agg(coalesce(r.to_key, e.key), e.value order by r.to_key is not null, e.key)
             from jsonb_each(s.metadata) e
             left join (values ${RENAME_VALUES}) r(from_key, to_key) on r.from_key = e.key
         )
       where s.session_id in (
         select w.session_id
           from kortix.project_sessions w
          where w.metadata ?| ${OLD_KEYS}
          limit ${BATCH}
       )
    `);
    if (!rowCount) return;
  }
  throw new Error('session_metadata_runtime_keys: batch bound reached');
};

export const down = false;
