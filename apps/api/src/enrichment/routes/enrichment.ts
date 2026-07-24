/**
 * The enrichment HTTP surface.
 *
 * Both routes are deliberately thin. Submitting a domain does validation,
 * tenancy and dedup, then hands off to the queue — the crawl takes minutes and
 * the global request deadline is 25 seconds, so the work cannot happen here.
 * Reading a job is a plain row lookup.
 *
 * The router is built by a factory taking its collaborators as arguments. That
 * is what lets the route tests exercise validation, tenancy and dedup with
 * stubs instead of `mock.module`, which in this suite is process-wide and
 * leaks into sibling test files.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { config } from '../../config';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import { enforceRateLimit, TokenBucketRateLimiter } from '../../shared/rate-limit';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import type { AppEnv } from '../../types';
import { EnrichmentError } from '../errors';
import { enqueueJob, getJobForAccount, type EnrichmentJobRow } from '../repositories/jobs';
import { idempotencyKey, normalizeDomain } from '../services/normalize';

// Exported so tests can reset them: the buckets are module-level state, and a
// suite sharing them across cases would fail on ordering rather than behaviour.
export const userLimiter = new TokenBucketRateLimiter('enrichment_user');
export const accountLimiter = new TokenBucketRateLimiter('enrichment_account');

/**
 * Two buckets, because they stop different things: the per-user one stops one
 * person scripting submissions, the per-account one stops a team collectively
 * saturating the worker and the shared outbound quota. Applied as middleware
 * (the house pattern) so the typed handlers only ever return their own
 * declared responses.
 */
export function createEnrichmentRateLimitMiddleware() {
  return async (c: Context<AppEnv>, next: Next) => {
    const userId = c.get('userId') as string;

    const userDenied = await enforceRateLimit(
      c,
      userLimiter,
      userId,
      { limit: config.KORTIX_ENRICHMENT_REQS_PER_MIN_USER, windowMs: 60_000 },
      {
        actorUserId: userId,
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'enrichment',
        resourceId: null,
        metadata: { limiter: 'enrichment_user' },
      },
    );
    if (userDenied) return userDenied;

    const accountId = await resolveScopedAccountId(c, 'body');
    const accountDenied = await enforceRateLimit(
      c,
      accountLimiter,
      accountId,
      { limit: config.KORTIX_ENRICHMENT_REQS_PER_MIN_ACCOUNT, windowMs: 60_000 },
      {
        accountId,
        actorUserId: userId,
        action: `RATE_LIMIT ${c.req.method} ${c.req.path}`,
        resourceType: 'enrichment',
        resourceId: null,
        metadata: { limiter: 'enrichment_account' },
      },
    );
    if (accountDenied) return accountDenied;

    await next();
  };
}

const SubmitBodySchema = z.object({
  domain: z.string().min(1).openapi({ example: 'example.com' }),
  projectId: z.string().uuid(),
  force: z.boolean().optional(),
  account_id: z.string().uuid().optional(),
});

const JobSchema = z.object({
  jobId: z.string(),
  domain: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_lettered']),
  errorCode: z.string().nullable(),
  result: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export function serializeJob(job: EnrichmentJobRow) {
  return {
    jobId: job.jobId,
    domain: job.domain,
    status: job.status,
    errorCode: job.errorCode,
    result: (job.result as Record<string, unknown> | null) ?? null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

export interface EnrichmentRouteDeps {
  resolveAccountId: (c: Context<AppEnv>, source: 'query' | 'body') => Promise<string>;
  projectBelongsToAccount: (projectId: string, accountId: string) => Promise<boolean>;
  enqueue: typeof enqueueJob;
  getJob: typeof getJobForAccount;
}

export const defaultEnrichmentRouteDeps: EnrichmentRouteDeps = {
  resolveAccountId: (c, source) => resolveScopedAccountId(c, source),
  projectBelongsToAccount: async (projectId, accountId) => {
    const [row] = await db
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(and(eq(projects.projectId, projectId), eq(projects.accountId, accountId)))
      .limit(1);
    return !!row;
  },
  enqueue: enqueueJob,
  getJob: getJobForAccount,
};

export function createEnrichmentRouter(deps: EnrichmentRouteDeps = defaultEnrichmentRouteDeps) {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'post',
      path: '/domains',
      tags: ['enrichment'],
      summary: 'Enrich a domain into a project’s company memory',
      description:
        'Queues a crawl + extraction for the domain and returns immediately. Poll `GET /v1/enrichment/jobs/{id}` for the outcome. A request for a domain already being enriched for this project attaches to the in-flight job instead of starting a second one.',
      ...auth,
      request: { body: { content: { 'application/json': { schema: SubmitBodySchema } } } },
      responses: {
        200: json(JobSchema, 'Attached to an in-flight job for this domain'),
        202: json(JobSchema, 'Enrichment queued'),
        400: json(
          z.object({ error: z.string(), message: z.string(), status: z.number() }),
          'The domain could not be used',
        ),
        ...errors(401, 403, 404, 429),
      },
    }),
    async (c) => {
      const userId = c.get('userId') as string;
      const body = c.req.valid('json');
      const accountId = await deps.resolveAccountId(c, 'body');

      let domain: string;
      try {
        domain = normalizeDomain(body.domain);
      } catch (err) {
        if (err instanceof EnrichmentError) {
          return c.json({ error: err.code, message: err.message, status: 400 }, 400);
        }
        throw err;
      }

      // A profile is written INTO the project's repo, so the project must
      // belong to the resolved account — otherwise a member of one org could
      // write memory into another org's repository.
      if (!(await deps.projectBelongsToAccount(body.projectId, accountId))) {
        throw new HTTPException(404, { message: 'Project not found' });
      }

      const { job, attached } = await deps.enqueue({
        accountId,
        projectId: body.projectId,
        createdBy: userId,
        domain,
        idempotencyKey: idempotencyKey(body.projectId, domain),
        force: body.force === true,
      });

      if (attached) return c.json(serializeJob(job), 200);
      return c.json(serializeJob(job), 202);
    },
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/jobs/{id}',
      tags: ['enrichment'],
      summary: 'Read an enrichment job',
      ...auth,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 200: json(JobSchema, 'The job'), ...errors(401, 404) },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const accountId = await deps.resolveAccountId(c, 'query');

      // Scoped by account, so a job id belonging to another tenant is
      // indistinguishable from one that does not exist.
      const job = await deps.getJob(id, accountId);
      if (!job) throw new HTTPException(404, { message: 'Job not found' });

      return c.json(serializeJob(job), 200);
    },
  );

  return router;
}
