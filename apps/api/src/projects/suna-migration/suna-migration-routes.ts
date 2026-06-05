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
import { sunaAccountMigrations } from '@kortix/db';

type Row = typeof sunaAccountMigrations.$inferSelect;

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
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM public.projects WHERE account_id = ${accountId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
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
      const latest = await latestSunaMigration(db, accountId);
      // Already done or in-flight → not eligible to start (UI shows status/hides).
      if (latest && ['completed', 'running', 'planned'].includes(latest.status)) {
        return c.json({ eligible: false, migration: serialize(latest) });
      }
      const eligible = (await countSunaProjects(accountId)) > 0;
      return c.json({ eligible, migration: serialize(latest) });
    },
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/suna-migration/start', tags: ['projects'],
      summary: 'Start the Suna → opencode migration for the account', ...auth,
      request: { body: { content: { 'application/json': { schema: z.object({ account_id: z.string().optional() }) } } } },
      responses: {
        200: json(z.object({ created: z.boolean(), migration: z.any() }), 'Existing in-flight migration'),
        202: json(z.object({ created: z.boolean(), migration: z.any() }), 'Migration started'),
        400: json(ErrorSchema, 'Nothing to migrate'),
        ...errors(401),
      },
    }),
    async (c: any) => {
      const accountId = await resolveScopedAccountId(c, 'body');
      if ((await countSunaProjects(accountId)) === 0) {
        return c.json({ error: 'No Suna projects found for this account' }, 400);
      }
      const { migration, created } = await startSunaMigration({ database: db, accountId });
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
