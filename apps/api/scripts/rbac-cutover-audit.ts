#!/usr/bin/env bun
/**
 * Cutover precondition audit — "is every legacy authorization fact already in
 * `kortix.role_assignments`?"
 *
 *   cd apps/api && dotenvx run -q -- bun scripts/rbac-cutover-audit.ts
 *
 * migrations-pending/README.md precondition 4 says: assert the row counts match
 * before dropping anything, and a non-zero delta means a writer was missed.
 * A raw count comparison is not enough — two stores can hold the same NUMBER of
 * rows and disagree about which rows those are. This script does the anti-join
 * in both directions, per legacy store:
 *
 *   legacy_only     a legacy row with NO canonical assignment. THIS IS THE GATE.
 *                   Any non-zero value means the cutover would delete an
 *                   authorization fact. Exit code 1.
 *   canonical_only  a canonical assignment of that class with no legacy row.
 *                   Expected to be non-zero and NOT a failure: `assignRole()` is
 *                   the only write path, and it deliberately leaves the legacy
 *                   column stale (see the dual-write mirror's "DIRECTION IS
 *                   ONE-WAY" header). Printed so the delta is visible, never
 *                   guessed at.
 *
 * Runs against whatever DATABASE_URL points at. Read-only: no INSERT, UPDATE,
 * DELETE or DDL, so it is safe against dev/staging/prod.
 *
 * After the cutover the legacy names are VIEWS over role_assignments, so every
 * legacy_only is 0 by construction — that is the proof the view shapes did not
 * lose a row, and the reason this script keeps working (and keeps being run)
 * after the tables are gone.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db';

/**
 * uuid5 namespace for a `pending` (invitee) principal. MUST match
 * KORTIX_PENDING_PRINCIPAL_NAMESPACE in src/iam/actor.ts and PENDING_NS in
 * 20260819015725000_rbac_backfill_role_assignments.concurrent.ts.
 */
const PENDING_NS = 'b8d1f9c6-0a7e-4a2f-9d3b-5e6c7a8b9c01';

interface Probe {
  /** Legacy store this row audits. */
  table: string;
  /** Relations that must exist for the probe to run (skipped if any is gone). */
  requires: readonly string[];
  /** COUNT of legacy rows with no canonical counterpart. */
  legacyOnly: string;
  /** COUNT of canonical rows of this class with no legacy counterpart. */
  canonicalOnly: string;
}

async function relationExists(qualified: string): Promise<boolean> {
  const [schema, name] = qualified.split('.');
  const res = await db.execute(
    sql`select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = ${schema} and c.relname = ${name}
         limit 1`,
  );
  return rows(res).length > 0;
}

function rows(res: unknown): Record<string, unknown>[] {
  // drizzle's node-postgres driver returns a pg.Result; the postgres-js driver
  // returns the array itself. Accept both so the script does not care which
  // driver `createDb` picked.
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  return ((res as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
}

async function count(query: string): Promise<number> {
  const res = await db.execute(sql.raw(query));
  const first = rows(res)[0];
  return Number(first?.n ?? 0);
}

/** The join every probe needs: the SYSTEM role behind an assignment. */
const SYSTEM_ROLE = `join kortix.iam_roles r
                       on r.role_id = ra.role_id
                      and r.account_id is null`;

/** normalizeProjectRole, in SQL — identical to the backfill's PROJECT_ROLE_KEY. */
const roleKey = (col: string) =>
  `(case ${col}::text
      when 'editor' then 'manager'
      when 'viewer' then 'member'
      when 'user'   then 'member'
      else ${col}::text
    end)`;

function probes(uuid5: (text: string) => string): Probe[] {
  return [
    {
      table: 'account_members.account_role',
      requires: ['kortix.account_members'],
      legacyOnly: `
        select count(*) n from kortix.account_members m
         where not exists (
           select 1 from kortix.role_assignments ra ${SYSTEM_ROLE}
            where ra.account_id = m.account_id
              and ra.principal_type = 'user'
              and ra.principal_id = m.user_id
              and ra.scope_type = 'account'
              and ra.object_type is null
              and r.scope_type = 'account'
              and r.key = m.account_role::text)`,
      canonicalOnly: `
        select count(*) n from kortix.role_assignments ra ${SYSTEM_ROLE}
         where ra.principal_type = 'user'
           and ra.scope_type = 'account'
           and ra.object_type is null
           and r.scope_type = 'account'
           and not exists (
             select 1 from kortix.account_members m
              where m.account_id = ra.account_id
                and m.user_id = ra.principal_id
                and m.account_role::text = r.key)`,
    },
    {
      table: 'project_members',
      requires: ['kortix.project_members'],
      legacyOnly: `
        select count(*) n from kortix.project_members pm
         where not exists (
           select 1 from kortix.role_assignments ra ${SYSTEM_ROLE}
            where ra.account_id = pm.account_id
              and ra.principal_type = 'user'
              and ra.principal_id = pm.user_id
              and ra.scope_type = 'project'
              and ra.scope_id = pm.project_id
              and ra.object_type is null
              and r.scope_type = 'project'
              and r.key = ${roleKey('pm.project_role')})`,
      canonicalOnly: `
        select count(*) n from kortix.role_assignments ra ${SYSTEM_ROLE}
         where ra.principal_type = 'user'
           and ra.scope_type = 'project'
           and ra.object_type is null
           and r.scope_type = 'project'
           and r.key in ('manager','member')
           and not exists (
             select 1 from kortix.project_members pm
              where pm.project_id = ra.scope_id
                and pm.user_id = ra.principal_id
                and ${roleKey('pm.project_role')} = r.key)`,
    },
    {
      table: 'project_group_grants',
      requires: ['kortix.project_group_grants'],
      legacyOnly: `
        select count(*) n from kortix.project_group_grants g
         where not exists (
           select 1 from kortix.role_assignments ra ${SYSTEM_ROLE}
            where ra.account_id = g.account_id
              and ra.principal_type = 'group'
              and ra.principal_id = g.group_id
              and ra.scope_type = 'project'
              and ra.scope_id = g.project_id
              and ra.object_type is null
              and r.scope_type = 'project'
              and r.key = ${roleKey('g.role')})`,
      canonicalOnly: `
        select count(*) n from kortix.role_assignments ra ${SYSTEM_ROLE}
         where ra.principal_type = 'group'
           and ra.scope_type = 'project'
           and ra.object_type is null
           and r.scope_type = 'project'
           and r.key in ('manager','member')
           and not exists (
             select 1 from kortix.project_group_grants g
              where g.project_id = ra.scope_id
                and g.group_id = ra.principal_id
                and ${roleKey('g.role')} = r.key)`,
    },
    {
      table: 'iam_policies',
      requires: ['kortix.iam_policies'],
      // The backfill skipped rows with an unknown principal type or a scope
      // whose id disagrees with its type. Those are NOT stranded facts — the
      // engine never honoured them either — so the same guard is applied here
      // rather than counting them as a missed writer.
      legacyOnly: `
        select count(*) n from kortix.iam_policies p
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
                and ra.object_type is null)`,
      canonicalOnly: `
        select count(*) n
          from kortix.role_assignments ra
          join kortix.iam_roles r on r.role_id = ra.role_id and r.account_id is not null
         where ra.object_type is null
           and ra.principal_type in ('user','group','service_account')
           and not exists (
             select 1 from kortix.iam_policies p
              where p.account_id = ra.account_id
                and p.principal_id = ra.principal_id
                and p.role_id = ra.role_id
                and p.scope_type = ra.scope_type
                and p.scope_id is not distinct from ra.scope_id
                and case p.principal_type
                      when 'member' then 'user'
                      when 'group'  then 'group'
                      when 'token'  then 'service_account'
                    end = ra.principal_type)`,
    },
    {
      table: 'iam_resource_grants',
      requires: ['kortix.iam_resource_grants'],
      // effect <> 'allow' was never honoured by any read path and is skipped by
      // the backfill and the mirror alike; counting it would report a fact the
      // system has never had.
      legacyOnly: `
        select count(*) n from kortix.iam_resource_grants rg
         where rg.effect = 'allow'
           and rg.principal_type in ('member','group')
           and rg.resource_type in ('agent','skill','secret','app','trigger')
           and not exists (
             select 1 from kortix.role_assignments ra
              where ra.account_id = rg.account_id
                and ra.principal_type = case rg.principal_type when 'member' then 'user' else 'group' end
                and ra.principal_id = rg.principal_id
                and ra.scope_type = 'project'
                and ra.scope_id = rg.project_id
                and ra.object_type = rg.resource_type
                and ra.object_id = rg.resource_id)`,
      canonicalOnly: `
        select count(*) n from kortix.role_assignments ra
         where ra.object_type is not null
           and ra.principal_type in ('user','group')
           and not exists (
             select 1 from kortix.iam_resource_grants rg
              where rg.account_id = ra.account_id
                and rg.project_id = ra.scope_id
                and rg.resource_type = ra.object_type
                and rg.resource_id = ra.object_id
                and rg.principal_id = ra.principal_id
                and case rg.principal_type when 'member' then 'user' else 'group' end = ra.principal_type)`,
    },
    {
      table: 'account_invitations.bootstrap_grants',
      requires: ['kortix.account_invitations'],
      // `bootstrap_grants` is a jsonb blob with no foreign key, so it can name a
      // project that has since been deleted. `role_assignments.scope_id` DOES
      // have one (added by 20260819160100000), so such an element has no
      // canonical counterpart and never can — and it never had an effect either:
      // the accept path materialises a grant on a project that does not exist.
      // Requiring the project to be live is what makes this probe compare like
      // with like instead of reporting dead JSON as a missed writer.
      legacyOnly: `
        select count(*) n
          from kortix.account_invitations a
          cross join lateral jsonb_array_elements(a.bootstrap_grants) as e
         where a.bootstrap_grants is not null
           and a.accepted_at is null
           and a.expires_at > now()
           and e ? 'project_id'
           and e->>'role' is not null
           and exists (select 1 from kortix.projects p where p.project_id = (e->>'project_id')::uuid)
           and not exists (
             select 1 from kortix.role_assignments ra ${SYSTEM_ROLE}
              where ra.account_id = a.account_id
                and ra.principal_type = 'pending'
                and ra.principal_id = ${uuid5('lower(a.email)')}
                and ra.scope_type = 'project'
                and ra.scope_id = (e->>'project_id')::uuid
                and ra.object_type is null
                and r.scope_type = 'project'
                and r.key = ${roleKey(`(e->>'role')`)})`,
      canonicalOnly: `
        select count(*) n from kortix.role_assignments ra
         where ra.principal_type = 'pending'
           and not exists (
             select 1
               from kortix.account_invitations a
               cross join lateral jsonb_array_elements(a.bootstrap_grants) as e
              where a.account_id = ra.account_id
                and ${uuid5('lower(a.email)')} = ra.principal_id
                and (e->>'project_id')::uuid = ra.scope_id)`,
    },
  ];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

async function main(): Promise<void> {
  // uuid-ossp's schema is not fixed across environments, so resolve it the way
  // the backfill migration does instead of hard-coding `public.`.
  const fn = await db.execute(
    sql`select n.nspname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.proname = 'uuid_generate_v5'
         limit 1`,
  );
  const uuidNs = rows(fn)[0]?.nspname as string | undefined;
  const uuid5 = uuidNs
    ? (text: string) => `${uuidNs}.uuid_generate_v5('${PENDING_NS}'::uuid, ${text})`
    : null;

  const results: { table: string; legacy: number | null; canonical: number | null; note: string }[] = [];
  let stranded = 0;

  for (const p of probes(uuid5 ?? ((t) => t))) {
    const missing: string[] = [];
    for (const rel of p.requires) {
      if (!(await relationExists(rel))) missing.push(rel);
    }
    if (missing.length > 0) {
      results.push({ table: p.table, legacy: null, canonical: null, note: `skipped — ${missing.join(', ')} does not exist` });
      continue;
    }
    if (!uuid5 && p.table.startsWith('account_invitations')) {
      results.push({ table: p.table, legacy: null, canonical: null, note: 'skipped — uuid_generate_v5 not installed' });
      continue;
    }
    const legacy = await count(p.legacyOnly);
    const canonical = await count(p.canonicalOnly);
    stranded += legacy;
    results.push({ table: p.table, legacy, canonical, note: legacy === 0 ? 'ok' : 'STRANDED — a writer was missed' });
  }

  const total = await count('select count(*) n from kortix.role_assignments');

  const w = Math.max(...results.map((r) => r.table.length), 'legacy store'.length);
  console.log(`${pad('legacy store', w)}  ${padLeft('legacy_only', 12)}  ${padLeft('canonical_only', 15)}  note`);
  console.log(`${'-'.repeat(w)}  ${'-'.repeat(12)}  ${'-'.repeat(15)}  ${'-'.repeat(28)}`);
  for (const r of results) {
    console.log(
      `${pad(r.table, w)}  ${padLeft(r.legacy === null ? '-' : String(r.legacy), 12)}  ` +
        `${padLeft(r.canonical === null ? '-' : String(r.canonical), 15)}  ${r.note}`,
    );
  }
  console.log(`\nkortix.role_assignments: ${total} row(s)`);

  if (stranded > 0) {
    console.log(
      `\nFAIL: ${stranded} legacy row(s) have no canonical assignment. ` +
        'Do not run the cutover migration — find the writer, route it through assignRole(), re-run the backfill.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS: every legacy authorization fact exists in kortix.role_assignments.');
}

await main();
process.exit(process.exitCode ?? 0);
