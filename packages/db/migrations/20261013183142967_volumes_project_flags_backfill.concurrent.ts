// Migration: volumes_project_flags_backfill  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: two idempotent passes over kortix.projects, each a loop of
// short committed statements of 500 rows. Every row a pass touches gains the
// key its selection excludes, so each loop ends when a batch changes nothing.
//
// Volumes and Stateless sessions move from one value per organization (the
// `session_boot_modes` platform setting) to ordinary project feature flags
// (`metadata.experimental.volumes`, `metadata.experimental.stateless_sessions`).
// The API now reads only the project's own values, so every project whose
// organization had them on gets them on its own, and nothing turns off:
//
// 1. experimental.volumes = true on every project of an organization the
//    setting turned Volumes on for: its own entry, else the global switch,
//    else the percentage rollout (the same bucket boot-mode.ts used:
//    sha256('boot-mode:' || lower(account id)), first 4 bytes, mod 100).
//
// 2. experimental.stateless_sessions = true on every project with Volumes on
//    whose organization's own boot-mode rule was `volume`, unless the kill
//    switch was on (it forced every new box to boot from the image).
//
// A project that already holds its own value for a flag keeps it. The
// setting row is left as it is. updated_at is never written.
//
// mixed-version-safe: the previous API ignores a project's own value for
// both flags (it reads the organization setting), so it behaves the same
// before and after this pass.

export const shorthands = undefined;

const BATCH = 500;
// A bound, not an expectation: every pass shrinks its own selection.
const MAX_BATCHES = 10000;

const SETTING = `(select value from kortix.platform_settings where key = 'session_boot_modes')`;

/** Volumes was on for the project's organization (p is kortix.projects). */
const VOLUMES_ON = `
  case
    when jsonb_typeof(${SETTING}->'volumes'->'orgs'->lower(p.account_id::text)) = 'boolean'
      then (${SETTING}->'volumes'->'orgs'->>lower(p.account_id::text))::boolean
    when (${SETTING}->'volumes'->>'enabled') = 'true' then true
    when coalesce((${SETTING}->'volumes'->>'percent')::numeric, 0) > 0
      then (('x' || substr(encode(sha256(convert_to('boot-mode:' || lower(p.account_id::text), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 100)
           < (${SETTING}->'volumes'->>'percent')::numeric
    else false
  end`;

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
    throw new Error('volumes_project_flags_backfill: batch bound reached');
  };

  const setFlag = (key, where) => `
    update kortix.projects t
       set metadata = jsonb_set(
             coalesce(t.metadata, '{}'::jsonb),
             '{experimental}',
             coalesce(t.metadata->'experimental', '{}'::jsonb) || jsonb_build_object('${key}', true)
           )
     where t.project_id in (
       select p.project_id
         from kortix.projects p
        where ${SETTING} is not null
          and (p.metadata->'experimental'->'${key}') is null
          and ${where}
        limit ${BATCH}
     )
  `;

  await loop(setFlag('volumes', VOLUMES_ON));

  await loop(
    setFlag(
      'stateless_sessions',
      `(p.metadata->'experimental'->>'volumes') = 'true'
          and coalesce((${SETTING}->>'killSwitch')::boolean, false) = false
          and (${SETTING}->'orgs'->lower(p.account_id::text)->>'mode') = 'volume'`,
    ),
  );
};

export const down = false;
