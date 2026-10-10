// POST /v1/feedback — product feedback filed by agents and people.
//
// An agent (or a person through the CLI) submits structured feedback while it
// works: a kind, a message and optional context ids. One route, one store, one
// table (`kortix.feedback`, append-only). The rate limiter keys on the caller's
// user id, so a loop cannot fill the triage surface.
import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { feedback, type Database } from '@kortix/db';
import type { AppEnv } from '../types';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { createFeedbackRateLimitMiddleware } from '../middleware/rate-limit';
import { db as defaultDb } from '../shared/db';

export type FeedbackRow = typeof feedback.$inferSelect;

/** Who filed it. The web app files as `web`; every CLI caller is `cli`, or
 *  `agent` when the call runs inside a Kortix session sandbox. */
export const FEEDBACK_SOURCES = ['cli', 'agent', 'web'] as const;
export const FEEDBACK_KINDS = ['bug', 'idea', 'friction'] as const;

const SourceSchema = z.enum(FEEDBACK_SOURCES);
const KindSchema = z.enum(FEEDBACK_KINDS);

/** Optional context ids. Bounded: at most 8 keys, each ≤ 128 chars, values ≤
 *  256 chars — enough for project/session/sandbox ids, useless as a payload. */
const ContextSchema = z
  .record(z.string().min(1).max(128), z.string().max(256))
  .refine((v) => Object.keys(v).length <= 8, 'at most 8 context keys')
  .optional();

const FeedbackBodySchema = z
  .object({
    source: SourceSchema.optional().default('cli'),
    kind: KindSchema,
    message: z.string().trim().min(1).max(4000),
    context: ContextSchema,
  })
  .openapi('FeedbackBody');

const FeedbackReceiptSchema = z
  .object({
    id: z.string().uuid(),
    source: SourceSchema,
    kind: KindSchema,
    created_at: z.string(),
  })
  .openapi('FeedbackReceipt');

export interface InsertFeedbackInput {
  userId: string;
  accountId: string | null;
  source: (typeof FEEDBACK_SOURCES)[number];
  kind: (typeof FEEDBACK_KINDS)[number];
  message: string;
  context: Record<string, string> | null;
}

export interface FeedbackStore {
  insert(input: InsertFeedbackInput): Promise<FeedbackRow>;
}

export function createFeedbackStore(database: Database = defaultDb): FeedbackStore {
  return {
    async insert(input) {
      const [row] = await database.insert(feedback).values(input).returning();
      if (!row) throw new Error('feedback insert returned no row');
      return row;
    },
  };
}

export interface FeedbackAppDeps {
  store?: FeedbackStore;
  authMiddleware?: MiddlewareHandler;
  rateLimitMiddleware?: MiddlewareHandler;
}

export function createFeedbackApp(deps: FeedbackAppDeps = {}) {
  const store = () => deps.store ?? createFeedbackStore();
  const app = makeOpenApiApp<AppEnv>();
  // Auth resolves the identity first; the limiter reads it after. Both are
  // app-level so the typed handler keeps full inference.
  app.use('*', deps.authMiddleware ?? supabaseAuth);
  app.use('*', deps.rateLimitMiddleware ?? createFeedbackRateLimitMiddleware());

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['feedback'],
      summary: 'File product feedback on behalf of the caller',
      description:
        'Persists one feedback row for the authenticated caller. ' +
        'Rate limited per user; the receipt carries the stored id.',
      ...auth,
      request: {
        body: { required: true, content: { 'application/json': { schema: FeedbackBodySchema } } },
      },
      responses: {
        201: json(FeedbackReceiptSchema, 'Feedback filed'),
        ...errors(400, 401, 429),
      },
    }),
    async (c) => {
      const body = c.req.valid('json') as z.infer<typeof FeedbackBodySchema>;
      const row = await store().insert({
        userId: c.get('userId') as string,
        accountId: (c.get('accountId') as string | undefined) ?? null,
        source: body.source,
        kind: body.kind,
        message: body.message,
        context: body.context ?? null,
      });
      return c.json(
        { id: row.id, source: body.source, kind: body.kind, created_at: row.createdAt.toISOString() },
        201,
      );
    },
  );

  return app;
}

export const feedbackApp = createFeedbackApp();
