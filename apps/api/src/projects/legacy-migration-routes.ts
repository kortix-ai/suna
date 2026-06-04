/**
 * HTTP surface for the lazy, user-triggered legacy migration. Registered onto
 * projectsApp so it inherits supabaseAuth (sets userId). All routes are scoped
 * to the caller's own account — you can only migrate your own legacy sandboxes.
 *
 *   GET  /v1/projects/legacy-migration/eligibility  → drives the Migrate button
 *   POST /v1/projects/legacy-migration/start        → start (durable, no cancel)
 *   GET  /v1/projects/legacy-migration/status       → poll progress
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { legacySandboxMigrations, sandboxes } from '@kortix/db';
import { db } from '../shared/db';
import { resolveScopedAccountId } from '../shared/resolve-account';
import type { AppEnv } from '../types';
import { startMigration, PHASE_ORDER } from './legacy-migration-runner';
import { json, errors, auth, ErrorSchema } from '../openapi';

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

export function registerLegacyMigrationRoutes(app: OpenAPIHono<AppEnv>): void {
  // Eligibility + current state — what the /projects page calls on load.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/legacy-migration/eligibility',
      tags: ['projects'],
      summary: 'Legacy sandbox migration eligibility for the account',
      ...auth,
      request: { query: z.object({ account_id: z.string().optional() }) },
      responses: {
        200: json(
          z.object({ eligible: z.boolean(), sandboxes: z.array(z.any()) }),
          'Eligibility and listed legacy sandboxes',
        ),
        ...errors(401),
      },
    }),
    async (c: any) => {
    // Scope to the account the UI currently has selected (?account_id=), not the
    // user's primary membership — otherwise the same legacy machines (and their
    // "Migrated → Open" cards) would surface on every account's projects grid.
    const accountId = await resolveScopedAccountId(c, 'query');

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
        // (archived) or in-flight machines aren't re-offered; a failed OR
        // rolled-back one is (a rollback returns the machine to a clean
        // not-migrated state, so it must be migratable again).
        migratable:
          s.provider === MIGRATABLE_PROVIDER &&
          s.status !== 'archived' &&
          (!migration || migration.status === 'failed' || migration.status === 'rolled_back'),
        migration,
      };
    }))).filter((i): i is NonNullable<typeof i> => i !== null);

    // Eligible = at least one machine the user can actually migrate right now.
    const eligible = items.some((i) => i.migratable);
    return c.json({ eligible, sandboxes: items });
  },
  );

  // Start (or return the in-flight) migration for one legacy sandbox. Idempotent
  // and uncancellable: there is intentionally no DELETE/cancel route.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/legacy-migration/start',
      tags: ['projects'],
      summary: 'Start a legacy sandbox migration',
      ...auth,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({ sandbox_id: z.string(), account_id: z.string().optional() }),
            },
          },
        },
      },
      responses: {
        200: json(z.object({ created: z.boolean(), migration: z.any() }), 'Existing in-flight migration'),
        202: json(z.object({ created: z.boolean(), migration: z.any() }), 'Migration started'),
        400: json(ErrorSchema, 'Bad request'),
        404: json(ErrorSchema, 'Not found'),
        ...errors(401),
      },
    }),
    async (c: any) => {
    const accountId = await resolveScopedAccountId(c, 'body');
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
  },
  );

  // Poll a single sandbox's migration progress.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/legacy-migration/status',
      tags: ['projects'],
      summary: "Poll a legacy sandbox's migration progress",
      ...auth,
      request: { query: z.object({ sandbox_id: z.string(), account_id: z.string().optional() }) },
      responses: {
        200: json(z.object({ migration: z.any() }), 'Migration progress'),
        400: json(ErrorSchema, 'Bad request'),
        404: json(ErrorSchema, 'Not found'),
        ...errors(401),
      },
    }),
    async (c: any) => {
    const accountId = await resolveScopedAccountId(c, 'query');
    const sandboxId = c.req.query('sandbox_id');
    if (!sandboxId) return c.json({ error: 'sandbox_id is required' }, 400);

    const [owned] = await db
      .select({ sandboxId: sandboxes.sandboxId })
      .from(sandboxes)
      .where(and(eq(sandboxes.sandboxId, sandboxId), eq(sandboxes.accountId, accountId)))
      .limit(1);
    if (!owned) return c.json({ error: 'Legacy sandbox not found for this account' }, 404);

    return c.json({ migration: serializeMigration(await latestMigration(sandboxId)) });
  },
  );
}
