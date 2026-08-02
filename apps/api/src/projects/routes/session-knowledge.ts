import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { callerKortixSessionId } from '../lib/caller-session';
import { projectsApp } from '../lib/app';
import {
  SessionKnowledgeAccessError,
  readAgentKnowledgeForSession,
  searchAgentKnowledgeForSession,
} from '../lib/session-knowledge';

const LocatorSchema = z
  .object({
    page: z.number().int().positive().optional(),
    url: z.string().optional(),
    heading: z.string().optional(),
    row: z.number().int().positive().optional(),
  })
  .strict();

const CitationSchema = z.object({
  citation_id: z.string().uuid(),
  source_id: z.string().uuid(),
  source_slug: z.string(),
  source_title: z.string(),
  version_id: z.string().uuid(),
  locator: LocatorSchema,
});

const SearchResultSchema = z.object({
  content: z.string(),
  score: z.number(),
  lexical_score: z.number().nullable(),
  vector_score: z.number().nullable(),
  citation: CitationSchema,
});

const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(8_000),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();

function accessError(c: any, error: unknown): Response | null {
  if (!(error instanceof SessionKnowledgeAccessError)) return null;
  return c.json(
    { error: error.message, code: error.code },
    error.code === 'forbidden' ? 403 : 404,
  );
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/knowledge/search',
    tags: ['agent-knowledge'],
    summary: 'Search knowledge assigned to the authenticated session agent',
    ...auth,
    request: {
      params: z.object({ projectId: z.string().uuid(), sessionId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: SearchRequestSchema } } },
    },
    responses: {
      200: json(
        z.object({
          results: z.array(SearchResultSchema),
          mode: z.enum(['hybrid', 'lexical']),
          degraded_reason: z.string().nullable(),
        }),
        'Cited knowledge results',
      ),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    try {
      return c.json(
        await searchAgentKnowledgeForSession({
          projectId: c.req.param('projectId'),
          requestedSessionId: c.req.param('sessionId'),
          authenticatedSessionId: callerKortixSessionId(c),
          ...(c.req.valid('json') as z.infer<typeof SearchRequestSchema>),
        }),
      );
    } catch (error) {
      const response = accessError(c, error);
      if (response) return response;
      throw error;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/knowledge/{citationId}',
    tags: ['agent-knowledge'],
    summary: 'Read one cited chunk assigned to the authenticated session agent',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string().uuid(),
        sessionId: z.string().uuid(),
        citationId: z.string().uuid(),
      }),
    },
    responses: {
      200: json(z.object({ content: z.string(), citation: CitationSchema }), 'Cited knowledge chunk'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    try {
      const result = await readAgentKnowledgeForSession({
        projectId: c.req.param('projectId'),
        requestedSessionId: c.req.param('sessionId'),
        authenticatedSessionId: callerKortixSessionId(c),
        citationId: c.req.param('citationId'),
      });
      return result ? c.json(result) : c.json({ error: 'Knowledge citation was not found.' }, 404);
    } catch (error) {
      const response = accessError(c, error);
      if (response) return response;
      throw error;
    }
  },
);
