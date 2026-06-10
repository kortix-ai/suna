/**
 * HTTP surface for the user-triggered Suna → opencode migration. Mirrors
 * legacy-migration-routes. Scoped to the caller's own account.
 *
 *   GET  /v1/projects/suna-migration/eligibility  → drives the "Migrate" button
 *   POST /v1/projects/suna-migration/start        → start (durable, no cancel)
 *   GET  /v1/projects/suna-migration/status       → poll progress
 *
 * eligible = the account has OLD Suna data (public.projects rows) AND no
 * completed/in-flight migration yet. So the button shows ONLY for OG Suna users
 * and disappears once migrated.
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import type { AppEnv } from '../../types';
import { json, errors, auth, ErrorSchema } from '../../openapi';
import { startSunaMigration, latestSunaMigration, PHASE_ORDER } from './suna-migration-runner';
import { sunaAccountMigrations, type Database } from '@kortix/db';
import { withTimeout } from '../../shared/with-timeout';

type Row = typeof sunaAccountMigrations.$inferSelect;

// Wall-clock budget for the eligibility GET, kept comfortably under the
// frontend's 30s request timeout (apps/web/src/lib/api-client.ts → "Request
// timed out after 30s"). This handler is polled by the Migrate button /
// suna-migration banner (apps/web/src/hooks/legacy/use-suna-migration.ts:
// staleTime 15s, plus 2.5s polling while a migration is in flight), and it
// awaits two unbounded DB ops — `latestSunaMigration` and especially
// `countSunaProjects`, an un-LIMITed `count(*)` over the legacy `public.projects`
// table (the OG Suna dataset, which can be large). A slow/contended DB therefore
// let the request hang to the client's 30s abort and re-fire:
//   ApiError — Request timed out after 30s: /projects/suna-migration/eligibility
// Bounding the whole body guarantees the poll always answers fast; a degraded DB
// renders the button as "not eligible / unknown" instead of paging us. The
// losing query settles in the background and the next poll re-checks.
export const SUNA_ELIGIBILITY_BUDGET_MS = 12_000;

export interface SunaEligibilityPayload {
  eligible: boolean;
  migration: ReturnType<typeof serialize>;
}

// Safe degraded payload, surfaced when the DB is too slow: "not eligible, no
// migration info". The Migrate button simply doesn't show and the next poll
// re-checks once the DB recovers — strictly better than hanging the request.
export const SUNA_ELIGIBILITY_DEGRADED: SunaEligibilityPayload = {
  eligible: false,
  migration: null,
};

function serialize(row: Row | null) {
  if (!row) return null;
  const i = row.phase ? PHASE_ORDER.indexOf(row.phase as (typeof PHASE_ORDER)[number]) : -1;
  return {
    migration_id: row.migrationId,
    status: row.status,
    phase: row.phase,
    step: i >= 0 ? i + 1 : null,
    total_steps: PHASE_ORDER.length - 1,
    project_id: row.projectId,
    error: row.status === 'failed' ? row.error : null,
    started_at: row.startedAt,
    updated_at: row.updatedAt,
  };
}

async function countSunaProjects(accountId: string): Promise<number> {
  try {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM public.projects WHERE account_id = ${accountId}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } catch (err: any) {
    // No legacy Suna schema in this database (e.g. fresh/local deploys that
    // never imported OG Suna data) → the account simply has nothing to
    // migrate. Postgres 42P01 = undefined_table. Treat as "not eligible".
    if (err?.cause?.code === '42P01' || err?.code === '42P01') return 0;
    throw err;
  }
}

// Eligibility logic, extracted so the wall-clock degradation contract is
// unit-testable without booting the full route/server env.
export async function buildEligibility(
  database: Database,
  accountId: string,
): Promise<SunaEligibilityPayload> {
  const latest = await latestSunaMigration(database, accountId);
  if (latest && ['completed', 'running', 'planned'].includes(latest.status)) {
    return { eligible: false, migration: serialize(latest) };
  }
  const eligible = (await countSunaProjects(accountId)) > 0;
  return { eligible, migration: serialize(latest) };
}

export function registerSunaMigrationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/suna-migration/eligibility', tags: ['projects'],
      summary: 'Suna migration eligibility for the account', ...auth,
      request: { query: z.object({ account_id: z.string().optional() }) },
      responses: { 200: json(z.object({ eligible: z.boolean(), migration: z.any().nullable() }), 'Eligibility + current migration'), ...errors(401) },
    }),
    async (c: any) => {
      const accountId = await resolveScopedAccountId(c, 'query');
      let payload: SunaEligibilityPayload = SUNA_ELIGIBILITY_DEGRADED;
      try {
        payload = await withTimeout(
          buildEligibility(db, accountId),
          SUNA_ELIGIBILITY_BUDGET_MS,
          'suna-migration eligibility',
        );
      } catch {
        // DB too slow / failing — degrade to "not eligible" rather than hang to
        // the client's 30s abort. The losing query settles in the background;
        // the next poll re-checks once the DB recovers.
      }
      return c.json(payload);
    },
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/suna-migration/start', tags: ['projects'],
      summary: 'Start the Suna → opencode migration for the account', ...auth,
      request: { body: { content: { 'application/json': { schema: z.object({
        account_id: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      }) } } } },
      responses: {
        200: json(z.object({ created: z.boolean(), migration: z.any() }), 'Existing in-flight migration'),
        202: json(z.object({ created: z.boolean(), migration: z.any() }), 'Migration started'),
        400: json(ErrorSchema, 'Nothing to migrate'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const accountId = await resolveScopedAccountId(c, 'body');
      const body = await c.req.json().catch(() => ({}));
      if ((await countSunaProjects(accountId)) === 0) {
        return c.json({ error: 'No Suna projects found for this account' }, 400);
      }
      const { migration, created } = await startSunaMigration({
        database: db, accountId,
        limit: typeof body?.limit === 'number' ? body.limit : undefined,
        offset: typeof body?.offset === 'number' ? body.offset : undefined,
      });
      return c.json({ created, migration: serialize(migration) }, created ? 202 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/suna-migration/status', tags: ['projects'],
      summary: 'Poll the Suna migration progress', ...auth,
      request: { query: z.object({ account_id: z.string().optional() }) },
      responses: { 200: json(z.object({ migration: z.any().nullable() }), 'Migration progress'), ...errors(401) },
    }),
    async (c: any) => {
      const accountId = await resolveScopedAccountId(c, 'query');
      return c.json({ migration: serialize(await latestSunaMigration(db, accountId)) });
    },
  );
}
