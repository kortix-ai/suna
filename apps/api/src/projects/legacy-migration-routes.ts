/**
 * HTTP surface for the lazy, user-triggered legacy migration. Registered onto
 * projectsApp so it inherits supabaseAuth (sets userId). All routes are scoped
 * to the caller's own account — you can only migrate your own legacy sandboxes.
 *
 *   GET  /v1/projects/legacy-migration/eligibility  → drives the Migrate button
 *   POST /v1/projects/legacy-migration/start        → start (durable, no cancel)
 *   GET  /v1/projects/legacy-migration/status       → poll progress
 */
import type { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import type { AppEnv } from '../types';
import { startMigration, PHASE_ORDER } from './legacy-migration-runner';

// Legacy sandboxes worth offering a migration for. 'archived' is the post-
// migration end state — still listed (as "Migrated", with an Open link) but not
// re-offered.
const MIGRATABLE_STATUSES = ['provisioning', 'active', 'stopped', 'error'] as const;
const LISTED_STATUSES = [...MIGRATABLE_STATUSES, 'archived'] as const;

// Only JustAVPS VMs are migratable: the pipeline reaches the live machine via the
// JustAVPS control API + CF proxy (legacy-vm-access). Legacy daytona/local_docker
// sandboxes have no such reach path and are not offered.
const MIGRATABLE_PROVIDER = 'justavps' as const;

type MigrationRow = typeof legacySandboxMigrations.$inferSelect;

/** UI-facing view of a migration's progress. Never leaks rollback internals. */
function serializeMigration(row: MigrationRow | null) {
  if (!row) return null;
  const phaseIndex = row.phase ? PHASE_ORDER.indexOf(row.phase as (typeof PHASE_ORDER)[number]) : -1;
  return {
    migration_id: row.migrationId,
    sandbox_id: row.sandboxId,
    status: row.status, // running | completed | failed | planned | ...
    phase: row.phase,
    // Coarse progress for a progress bar: which step of the pipeline we're on.
    step: phaseIndex >= 0 ? phaseIndex + 1 : null,
    total_steps: PHASE_ORDER.length - 1, // 'done' is a marker, not a step
    project_id: row.projectId,
    error: row.status === 'failed' ? row.error : null,
    started_at: row.startedAt,
    updated_at: row.updatedAt,
  };
}

/**
 * The most recent migration for a sandbox (ANY status), for display. Unlike
 * findActiveMigration (which returns only a live row), this also surfaces a
 * completed/failed one so the UI can show "Migrated → Open" or a retry.
 */
async function latestMigration(sandboxId: string): Promise<MigrationRow | null> {
  const [row] = await db
    .select()
    .from(legacySandboxMigrations)
    .where(eq(legacySandboxMigrations.sandboxId, sandboxId))
    .orderBy(desc(legacySandboxMigrations.updatedAt))
    .limit(1);
  return row ?? null;
}

export function registerLegacyMigrationRoutes(app: Hono<AppEnv>): void {
  // Eligibility + current state — what the /projects page calls on load.
  app.get('/legacy-migration/eligibility', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);

    const legacy = await db
      .select({
        sandboxId: sandboxes.sandboxId,
        status: sandboxes.status,
        name: sandboxes.name,
        provider: sandboxes.provider,
        createdAt: sandboxes.createdAt,
      })
      .from(sandboxes)
      .where(and(eq(sandboxes.accountId, accountId), inArray(sandboxes.status, [...LISTED_STATUSES])))
      .orderBy(sandboxes.createdAt);

    const items = (await Promise.all(legacy.map(async (s) => {
      const migration = serializeMigration(await latestMigration(s.sandboxId));
      // An archived machine is only worth listing if it was actually migrated
      // (then we show "Migrated → Open"); otherwise it's just dead, hide it.
      if (s.status === 'archived' && !migration) return null;
      return {
        sandbox_id: s.sandboxId,
        name: s.name,
        status: s.status,
        provider: s.provider,
        created_at: s.createdAt,
        // Only JustAVPS machines can be migrated — the pipeline reaches the live
        // VM through the JustAVPS proxy (legacy-vm-access). Already migrated
        // (archived) or in-flight machines aren't re-offered; a failed one is.
        migratable:
          s.provider === MIGRATABLE_PROVIDER &&
          s.status !== 'archived' &&
          (!migration || migration.status === 'failed'),
        migration,
      };
    }))).filter((i): i is NonNullable<typeof i> => i !== null);

    // Eligible = at least one machine the user can actually migrate right now.
    const eligible = items.some((i) => i.migratable);
    return c.json({ eligible, sandboxes: items });
  });

  // Start (or return the in-flight) migration for one legacy sandbox. Idempotent
  // and uncancellable: there is intentionally no DELETE/cancel route.
  app.post('/legacy-migration/start', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const body = await c.req.json().catch(() => ({}));
    const sandboxId = typeof body?.sandbox_id === 'string' ? body.sandbox_id : null;
    if (!sandboxId) return c.json({ error: 'sandbox_id is required' }, 400);

    // Authorize: the sandbox must belong to the caller's account.
    const [owned] = await db
      .select({ sandboxId: sandboxes.sandboxId, provider: sandboxes.provider })
      .from(sandboxes)
      .where(and(eq(sandboxes.sandboxId, sandboxId), eq(sandboxes.accountId, accountId)))
      .limit(1);
    if (!owned) return c.json({ error: 'Legacy sandbox not found for this account' }, 404);
    // Only JustAVPS machines have a reachable migration path.
    if (owned.provider !== MIGRATABLE_PROVIDER) {
      return c.json({ error: `Only JustAVPS machines can be migrated (got provider "${owned.provider}")` }, 400);
    }

    const { migration, created } = await startMigration({ database: db, sandboxId, accountId });
    return c.json({ created, migration: serializeMigration(migration) }, created ? 202 : 200);
  });

  // Poll a single sandbox's migration progress.
  app.get('/legacy-migration/status', async (c) => {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const sandboxId = c.req.query('sandbox_id');
    if (!sandboxId) return c.json({ error: 'sandbox_id is required' }, 400);

    const [owned] = await db
      .select({ sandboxId: sandboxes.sandboxId })
      .from(sandboxes)
      .where(and(eq(sandboxes.sandboxId, sandboxId), eq(sandboxes.accountId, accountId)))
      .limit(1);
    if (!owned) return c.json({ error: 'Legacy sandbox not found for this account' }, 404);

    return c.json({ migration: serializeMigration(await latestMigration(sandboxId)) });
  });
}
