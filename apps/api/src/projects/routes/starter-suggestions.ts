import { createRoute, z } from '@hono/zod-openapi';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';
import { projectSessions } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { logger as appLogger } from '../../lib/logger';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  filterConnectedConnectorItems,
  generateStarterSuggestions,
  isSuggestionsCacheStaleForActivity,
  readSuggestionsCache,
} from '../starter-suggestions/generate';
import { SUGGESTION_ACTIONS } from '../starter-suggestions/sanitize';
import { readConnectedConnectors, type ConnectedConnector } from '../starter-suggestions/signals';

// GET /v1/projects/:projectId/starter-suggestions
//
// Project-home composer suggestions. Always answers instantly from whatever is
// already known — the personalized cache in `projects.metadata.starter_suggestions`
// when one exists, otherwise the static `STARTER_PROMPT_FALLBACKS` pool — and never
// blocks the response on generation. When the cache is missing or older than the
// TTL, a regeneration is fired `void` (fire-and-forget, never throws) so the NEXT
// read picks up fresher suggestions. Cache staleness decides only whether a
// regeneration is queued, never what THIS response answers with.

const StarterSuggestionItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
  action: z.enum(SUGGESTION_ACTIONS).optional(),
  // Enriched, generator-set only — see the two-stage design note on
  // `StarterSuggestionItem` (`../starter-suggestions/sanitize.ts`). Never
  // present on the static `STARTER_PROMPT_FALLBACKS` pool below.
  connector: z
    .object({ slug: z.string(), name: z.string(), img_src: z.string().nullable() })
    .optional(),
});

const StarterSuggestionsResponseSchema = z.object({
  source: z.enum(['personalized', 'static']),
  generated_at: z.string().nullable(),
  items: z.array(StarterSuggestionItemSchema),
});

/**
 * Cheap recency + identity read for the activity-aware refresh and the
 * serve-time connected-filter: `max(updated_at)` across the project's
 * sessions, `readConnectedConnectors`' own per-connection `updatedAt` for
 * the connector side (one query serves both — see its doc comment), and the
 * connected-connector list itself for filtering.
 *
 * Try/catch'd as a whole: a failure here must never 5xx the request that
 * happened to trigger it, only degrade to the plain 24h staleness rule and
 * an unfiltered response (both fail open on an empty/null result).
 */
async function readActivityAndConnected(
  projectId: string,
): Promise<{ lastActivityAt: Date | null; connected: ConnectedConnector[] }> {
  try {
    const [sessionRows, connected] = await Promise.all([
      db
        .select({ max: sql<Date | null>`max(${projectSessions.updatedAt})` })
        .from(projectSessions)
        .where(eq(projectSessions.projectId, projectId)),
      readConnectedConnectors(projectId),
    ]);
    const sessionMax = sessionRows[0]?.max ?? null;
    const connectorMax = connected.reduce<Date | null>(
      (latest, c) => (!latest || c.updatedAt > latest ? c.updatedAt : latest),
      null,
    );
    const lastActivityAt =
      sessionMax && connectorMax
        ? sessionMax > connectorMax
          ? sessionMax
          : connectorMax
        : (sessionMax ?? connectorMax);
    return { lastActivityAt, connected };
  } catch (err) {
    appLogger.warn('[starter-suggestions] failed to read project activity/connectors', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { lastActivityAt: null, connected: [] };
  }
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/starter-suggestions',
    tags: ['projects'],
    summary: 'GET /:projectId/starter-suggestions',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(StarterSuggestionsResponseSchema, 'Starter-prompt suggestions'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const cache = readSuggestionsCache(loaded.row.metadata);

    // A null cache is unconditionally stale (`isSuggestionsCacheStaleForActivity`
    // falls through to `isSuggestionsCacheStale(null, …)`, always true) and has
    // no connector items to filter — skip the activity/connected read entirely
    // on that path so a fresh project still answers with zero extra queries.
    let connected: ConnectedConnector[] = [];
    if (cache) {
      const activity = await readActivityAndConnected(projectId);
      connected = activity.connected;
      if (isSuggestionsCacheStaleForActivity(cache, activity.lastActivityAt, new Date()) && config.STARTER_SUGGESTIONS_ENABLED) {
        // Fire-and-forget: never awaited, never throws (see generate.ts's own
        // top-level try/catch) — a generation failure must never turn into a 5xx
        // for the request that happened to trigger it.
        void generateStarterSuggestions({
          projectId,
          accountId: loaded.row.accountId,
          userId: loaded.userId,
        });
      }
    } else if (config.STARTER_SUGGESTIONS_ENABLED) {
      void generateStarterSuggestions({
        projectId,
        accountId: loaded.row.accountId,
        userId: loaded.userId,
      });
    }

    if (cache) {
      return c.json({
        source: 'personalized' as const,
        generated_at: cache.generated_at,
        items: filterConnectedConnectorItems(cache.items, connected),
      });
    }

    return c.json({
      source: 'static' as const,
      generated_at: null,
      items: STARTER_PROMPT_FALLBACKS.map(({ id, label, prompt }) => ({ id, label, prompt })),
    });
  },
);
