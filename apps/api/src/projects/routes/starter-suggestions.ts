import { createRoute, z } from '@hono/zod-openapi';
import { STARTER_PROMPT_FALLBACKS } from '@kortix/shared';
import { config } from '../../config';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import {
  generateStarterSuggestions,
  isSuggestionsCacheStale,
  readSuggestionsCache,
} from '../starter-suggestions/generate';
import { SUGGESTION_ACTIONS } from '../starter-suggestions/sanitize';

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
});

const StarterSuggestionsResponseSchema = z.object({
  source: z.enum(['personalized', 'static']),
  generated_at: z.string().nullable(),
  items: z.array(StarterSuggestionItemSchema),
});

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
    if (isSuggestionsCacheStale(cache, new Date()) && config.STARTER_SUGGESTIONS_ENABLED) {
      // Fire-and-forget: never awaited, never throws (see generate.ts's own
      // top-level try/catch) — a generation failure must never turn into a 5xx
      // for the request that happened to trigger it.
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
        items: cache.items,
      });
    }

    return c.json({
      source: 'static' as const,
      generated_at: null,
      items: STARTER_PROMPT_FALLBACKS.map(({ id, label, prompt }) => ({ id, label, prompt })),
    });
  },
);
