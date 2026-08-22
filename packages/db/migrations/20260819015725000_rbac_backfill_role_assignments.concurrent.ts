// Migration: rbac_backfill_role_assignments  (NON-TRANSACTIONAL — batched DML)
//
// Copies every existing authorization fact into kortix.role_assignments. Six
// sources, one target shape. Nothing is deleted and no legacy writer changes:
// this is the EXPAND half, and both stores stay live until the cutover PR.
//
//   1. account_members.account_role         -> (user, owner|admin|member, account)
//   2. project_members.project_role         -> (user, manager|member, project:id)
//   3. project_group_grants.role            -> (group, manager|member, project:id)
//   4. iam_policies                         -> (user|group|service_account,
//                                               <that custom role>, account|project)
//   5. iam_resource_grants                  -> (user|group, agent-user, project:id,
//                                               object=(type, id))
//   6. account_invitations.bootstrap_grants -> (pending, manager|member, project:id)
//
// batched-dml: six INSERT..SELECT passes in 1,000-row batches, each batch its
// own transaction (pgm.noTransaction()), each keyed on a NOT EXISTS anti-join
// against the target's (principal_type, principal_id) index so a batch only ever
// picks up rows it has not already copied. Row counts are bounded by membership
// cardinality — 33,363 / 1,990 / 7 / 398 / 10 / 247 on the local dataset — not by
// an event stream, so this is orders of magnitude below the audit-table case that
// motivated the guard (MIGRATIONS.md "Never backfill data inside a
// single-transaction migration"). Re-running is a no-op: every pass selects only
// rows with no matching assignment, and every INSERT carries ON CONFLICT DO
// NOTHING against uq_role_assignments_identity as a second guard.
//
// mixed-version-safe: DATA only, and only INTO A TABLE NO DEPLOYED CODE READS
// YET. No DDL, no lock on any legacy table definition, no legacy row modified.
// An API replica running the pre-PR2 image is completely unaffected; a replica
// running the post-PR2 image reads role_assignments, which this pass fills. A
// straggler write to a legacy table after this runs is NOT copied — that is what
// the cutover PR's dual-read views exist to cover, and why they are the step that
// must land before any reader is switched over (migrations-pending/README.md).
//
// LEGACY ROLE VALUES: project_role still carries the undroppable enum labels
// `editor` and `viewer`. They fold exactly as normalizeProjectRole folds them on
// read — editor -> manager, viewer -> member — so a row written by a pre-removal
// replica lands on the same permission set the engine already gives it. 0 such
// rows exist locally; the fold is written anyway because prod may differ.

export const shorthands = undefined;

const BATCH_SIZE = 1000;

/**
 * Namespace for the `pending` principal id: uuid5(NS, lower(invitee email)).
 * An invitee has no auth uid yet, so their ride-along project grants need a
 * stable synthetic principal that the accept path can recompute without a
 * lookup. MUST match KORTIX_PENDING_PRINCIPAL_NAMESPACE in
 * apps/api/src/iam/actor.ts.
 */
const PENDING_NS = 'b8d1f9c6-0a7e-4a2f-9d3b-5e6c7a8b9c01';

/**
 * Run `sql` until it stops inserting rows. Each call is its own implicit
 * transaction, so locks are released between batches.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
async function drain(pgm, label, sql) {
  let total = 0;
  for (let batch = 0; batch < 100_000; batch += 1) {
    const res = await pgm.db.query(sql);
    const n = res.rowCount ?? 0;
    total += n;
    if (n === 0) {
      // eslint-disable-next-line no-console
      console.log(`[rbac_backfill] ${label}: ${total} assignment(s) created`);
      return total;
    }
  }
  throw new Error(
    `[rbac_backfill] ${label}: still finding uncopied rows after 100,000 batches — aborting instead of looping forever`,
  );
}

/** SQL fragment: the system role for a scope + key expression. */
const SYSTEM_ROLE_JOIN = (scopeType, keyExpr) =>
  `join kortix.iam_roles sr
      on sr.account_id is null
     and sr.scope_type = '${scopeType}'
     and sr.key = ${keyExpr}`;

/** SQL fragment: normalizeProjectRole, in SQL. */
const PROJECT_ROLE_KEY = (col) =>
  `(case ${col}::text
      when 'editor' then 'manager'
      when 'viewer' then 'member'
      when 'user'   then 'member'
      else ${col}::text
    end)`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '120s'`);

  // uuid5 for the `pending` principal. uuid-ossp is present on every Supabase
  // environment and on the self-host bootstrap, but its schema is not fixed
  // (extensions/ vs public/), so resolve it instead of hard-coding.
  await pgm.db.query(`create extension if not exists "uuid-ossp"`);
  const fn = await pgm.db.query(
    `select n.nspname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'uuid_generate_v5'
      limit 1`,
  );
  const uuidNs = fn.rows[0]?.nspname;
  if (!uuidNs) {
    throw new Error(
      '[rbac_backfill] uuid_generate_v5 not found after CREATE EXTENSION "uuid-ossp" — cannot derive pending principal ids',
    );
  }
  const uuid5 = (text) => `${uuidNs}.uuid_generate_v5('${PENDING_NS}'::uuid, ${text})`;

  // ── 1. Account membership ────────────────────────────────────────────────
  // Membership itself becomes "has an active assignment at account scope".
  // scim_external_id marks the rows an IdP owns, so their provenance survives.
  await drain(
    pgm,
    'account_members',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id, source, created_at)
     select m.account_id, 'user', m.user_id, sr.role_id, 'account', null,
            case when m.scim_external_id is not null then 'scim' else 'system' end,
            m.joined_at
       from kortix.account_members m
       ${SYSTEM_ROLE_JOIN('account', 'm.account_role::text')}
      where not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = m.account_id
                 and ra.principal_type = 'user'
                 and ra.principal_id = m.user_id
                 and ra.role_id = sr.role_id
                 and ra.scope_type = 'account'
                 and ra.scope_id is null
                 and ra.object_type is null
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );

  // ── 2. Direct project membership ─────────────────────────────────────────
  await drain(
    pgm,
    'project_members',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
        expires_at, granted_by, source, created_at)
     select pm.account_id, 'user', pm.user_id, sr.role_id, 'project', pm.project_id,
            pm.expires_at, pm.granted_by, 'manual', pm.created_at
       from kortix.project_members pm
       ${SYSTEM_ROLE_JOIN('project', PROJECT_ROLE_KEY('pm.project_role'))}
      where not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = pm.account_id
                 and ra.principal_type = 'user'
                 and ra.principal_id = pm.user_id
                 and ra.role_id = sr.role_id
                 and ra.scope_type = 'project'
                 and ra.scope_id = pm.project_id
                 and ra.object_type is null
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );

  // ── 3. Group -> project grants ───────────────────────────────────────────
  await drain(
    pgm,
    'project_group_grants',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
        expires_at, granted_by, source, created_at)
     select g.account_id, 'group', g.group_id, sr.role_id, 'project', g.project_id,
            g.expires_at, g.granted_by, 'manual', g.created_at
       from kortix.project_group_grants g
       ${SYSTEM_ROLE_JOIN('project', PROJECT_ROLE_KEY('g.role'))}
      where not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = g.account_id
                 and ra.principal_type = 'group'
                 and ra.principal_id = g.group_id
                 and ra.role_id = sr.role_id
                 and ra.scope_type = 'project'
                 and ra.scope_id = g.project_id
                 and ra.object_type is null
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );

  // ── 4. Custom-role policies ──────────────────────────────────────────────
  // principal_type is renamed onto the canonical vocabulary: the legacy 'member'
  // meant an auth user, and 'token' meant a service account (the agent's
  // standing identity), which is exactly what the two names now say.
  // iam_policies has NO unique constraint, so duplicate bindings are legal there
  // and collapse to one assignment here — an intended narrowing, not data loss.
  await drain(
    pgm,
    'iam_policies',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
        expires_at, granted_by, source, created_at)
     select p.account_id,
            case p.principal_type
              when 'member' then 'user'
              when 'group'  then 'group'
              when 'token'  then 'service_account'
            end,
            p.principal_id, p.role_id, p.scope_type, p.scope_id,
            p.expires_at, p.granted_by, 'manual', p.created_at
       from kortix.iam_policies p
      where p.principal_type in ('member','group','token')
        and p.scope_type in ('account','project')
        and (p.scope_type = 'account') = (p.scope_id is null)
        and not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = p.account_id
                 and ra.principal_type = case p.principal_type
                                           when 'member' then 'user'
                                           when 'group'  then 'group'
                                           when 'token'  then 'service_account'
                                         end
                 and ra.principal_id = p.principal_id
                 and ra.role_id = p.role_id
                 and ra.scope_type = p.scope_type
                 and ra.scope_id is not distinct from p.scope_id
                 and ra.object_type is null
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );

  // ── 5. Per-object grants ─────────────────────────────────────────────────
  // effect is not carried: 'deny' was reserved and never written, and every read
  // filtered effect='allow'. Rows with any other effect are skipped rather than
  // silently promoted to allow.
  await drain(
    pgm,
    'iam_resource_grants',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
        object_type, object_id, expires_at, granted_by, source, created_at)
     select rg.account_id,
            case rg.principal_type when 'member' then 'user' else 'group' end,
            rg.principal_id, sr.role_id, 'project', rg.project_id,
            rg.resource_type, rg.resource_id,
            rg.expires_at, rg.granted_by, 'manual', rg.created_at
       from kortix.iam_resource_grants rg
       ${SYSTEM_ROLE_JOIN('project', `'agent-user'`)}
      where rg.effect = 'allow'
        and rg.principal_type in ('member','group')
        and rg.resource_type in ('agent','skill','secret','app','trigger')
        and not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = rg.account_id
                 and ra.principal_type = case rg.principal_type when 'member' then 'user' else 'group' end
                 and ra.principal_id = rg.principal_id
                 and ra.role_id = sr.role_id
                 and ra.scope_type = 'project'
                 and ra.scope_id = rg.project_id
                 and ra.object_type = rg.resource_type
                 and ra.object_id = rg.resource_id
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );

  // ── 6. Pending invites' ride-along project grants ────────────────────────
  // bootstrap_grants is a jsonb array of {project_id, role, expires_at?} and
  // {group_id}. Only the first shape is a ROLE assignment; a {group_id} element
  // is a group MEMBERSHIP that materialises into group_members on accept, so it
  // has no role to assign and is deliberately not copied.
  // An accepted or expired invite carries no live grant and is skipped.
  await drain(
    pgm,
    'account_invitations.bootstrap_grants',
    `insert into kortix.role_assignments
       (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
        expires_at, granted_by, source, created_at)
     select a.account_id, 'pending', ${uuid5('lower(a.email)')}, sr.role_id, 'project',
            (e->>'project_id')::uuid,
            nullif(e->>'expires_at','')::timestamptz,
            a.invited_by, 'invite', a.created_at
       from kortix.account_invitations a
       cross join lateral jsonb_array_elements(a.bootstrap_grants) as e
       ${SYSTEM_ROLE_JOIN('project', PROJECT_ROLE_KEY(`(e->>'role')`))}
      where a.bootstrap_grants is not null
        and a.accepted_at is null
        and a.expires_at > now()
        and e ? 'project_id'
        and e->>'role' is not null
        and not exists (
              select 1 from kortix.role_assignments ra
               where ra.account_id = a.account_id
                 and ra.principal_type = 'pending'
                 and ra.principal_id = ${uuid5('lower(a.email)')}
                 and ra.role_id = sr.role_id
                 and ra.scope_type = 'project'
                 and ra.scope_id = (e->>'project_id')::uuid
                 and ra.object_type is null
            )
      limit ${BATCH_SIZE}
     on conflict do nothing`,
  );
};

export const down = false;
