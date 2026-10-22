// Migration: session_initiator_backfill  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: idempotent passes, each a loop of short committed statements.
// Bounds measured read-only through the API on 2026-09-29: one prod project
// holds 4,269 sessions (2,875 top-level, 1,394 spawned, 1,209 legacy trigger
// rows with origin 'user'). Every row a pass touches leaves its selection
// predicate, so each loop ends when a batch changes nothing.
//
// Fills the columns 20260929125443169_session_initiator.sql added, with the
// rules the API now applies at create (projects/lib/session-initiator.ts and
// session-origin.ts `inheritParentOrigin`):
//
// 1. Legacy trigger rows: origin 'user' with a `trigger:*` source predate the
//    origin column's derivation. `trigger:cron` is 'schedule', every other
//    trigger source is 'trigger' (resolveSessionOrigin). Both classes are no
//    broader than 'user' (canOverride), and on-behalf-of already treats a row
//    with trigger metadata as unattended, so no permission changes.
//
// 2. parent_session_id <- metadata.spawned_by_session, when that session exists
//    in the same project. The metadata key stays (older replicas read it).
//
// 3. Top-level sessions get their initiator from resolveRootSessionInitiator:
//    trigger:* -> trigger (slug), system:* -> system (source), email/telegram
//    -> channel, slack/teams whose created_by is not an account member ->
//    channel, a service-account owner -> api, else member (created_by).
//
// 4. Spawned sessions copy their parent's initiator; take the parent's origin
//    when the parent's is unattended (trigger/schedule/system) and theirs is
//    'user' (never 'backend'); and their 'ui' source becomes 'agent'. A loop
//    iteration reaches only children whose parent is already classified, so a
//    chain classifies top-down.
//
// updated_at is never written: it is the session list's sort key. The only
// row trigger on project_sessions fires on UPDATE OF status. created_by is
// never changed. Row locks only; the house 5s lock budget keeps writers from
// queueing behind a batch.

export const shorthands = undefined;

const BATCH = 1000;
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
    throw new Error('session_initiator_backfill: batch bound reached');
  };

  await loop(`
    update kortix.project_sessions ps
       set origin = case when ps.metadata->>'source' = 'trigger:cron'
                         then 'schedule'::kortix.project_session_origin
                         else 'trigger'::kortix.project_session_origin end
     where ps.session_id in (
       select s.session_id
         from kortix.project_sessions s
        where s.origin = 'user'
          and s.metadata->>'source' like 'trigger:%'
        limit ${BATCH}
     )
  `);

  await loop(`
    update kortix.project_sessions ps
       set parent_session_id = ps.metadata->>'spawned_by_session'
     where ps.session_id in (
       select s.session_id
         from kortix.project_sessions s
         join kortix.project_sessions p
           on p.session_id = s.metadata->>'spawned_by_session'
          and p.project_id = s.project_id
          and p.session_id <> s.session_id
        where s.parent_session_id is null
        limit ${BATCH}
     )
  `);

  await loop(`
    update kortix.project_sessions ps
       set initiator_type = c.initiator_type,
           initiator_id = c.initiator_id
      from (
        select s.session_id,
               case
                 when src like 'trigger:%' then 'trigger'
                 when src like 'system:%' then 'system'
                 when src in ('email', 'telegram') then 'channel'
                 when src in ('slack', 'teams') and m.user_id is null then 'channel'
                 when sa.service_account_id is not null then 'api'
                 else 'member'
               end::kortix.project_session_initiator as initiator_type,
               case
                 when src like 'trigger:%' then s.metadata->>'trigger_slug'
                 when src like 'system:%' then src
                 when src in ('email', 'telegram') then src
                 when src in ('slack', 'teams') and m.user_id is null then src
                 else s.created_by::text
               end as initiator_id
          from (
            select s0.*, coalesce(s0.metadata->>'source', '') as src
              from kortix.project_sessions s0
             where s0.initiator_type is null
               and s0.parent_session_id is null
             limit ${BATCH}
          ) s
          left join kortix.account_memberships m
            on m.user_id = s.created_by and m.account_id = s.account_id
          left join kortix.service_accounts sa
            on sa.service_account_id = s.created_by
      ) c
     where ps.session_id = c.session_id
  `);

  await loop(`
    update kortix.project_sessions ps
       set initiator_type = p.initiator_type,
           initiator_id = p.initiator_id,
           origin = case when ps.origin = 'user' and p.origin in ('trigger', 'schedule', 'system')
                         then p.origin else ps.origin end,
           metadata = case when ps.metadata->>'source' = 'ui'
                           then jsonb_set(ps.metadata, '{source}', '"agent"')
                           else ps.metadata end
      from kortix.project_sessions p
     where p.session_id = ps.parent_session_id
       and ps.session_id in (
         select s.session_id
           from kortix.project_sessions s
           join kortix.project_sessions sp on sp.session_id = s.parent_session_id
          where s.initiator_type is null
            and sp.initiator_type is not null
          limit ${BATCH}
       )
  `);
};

export const down = false;
