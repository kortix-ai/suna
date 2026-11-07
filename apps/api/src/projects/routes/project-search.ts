/**
 * Search: `GET /v1/projects/:projectId/search`. One query over the whole of
 * a project's Files (the drive's search index, `drives/search-index/`),
 * filtered by who asks: a person by their folder access, a session by the
 * folders it may mount (also the ones past its mount slots). The handler
 * reads the request, picks the reader and maps the result; the rules live in
 * `drives/search-index/search.ts`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { normalizeDrivePath } from '../../drives/access';
import { usableDriveAgents } from '../../drives/agent-drives';
import { decodeCursor, parseLimit, parseSearchQuery, SEARCH_LIMITS } from '../../drives/search-index/query';
import { personSearchReader, searchDriveIndex, sessionSearchReader } from '../../drives/search-index/search';
import { findProjectDrive } from '../../drives/service';
import { actorFor } from '../../middleware/actor';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { workspaceIdParam } from '../../shared/route-params';

const HitSchema = z.object({
  /** The path in the project's Files, e.g. `/Company/plans/q3.md`. */
  path: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  /** A passage of the file's text around the query's words; null for a folder or a file with no indexed text. */
  snippet: z.string().nullable(),
  mtime: z.string().nullable(),
  size: z.number(),
  /** The caller's access at the path. */
  access: z.enum(['read', 'write', 'manage']),
});

const SearchBody = z.object({ hits: z.array(HitSchema), next_cursor: z.string().nullable() }).openapi('ProjectSearchResult');

const invalid = (c: Context<AppEnv>, error: string) => c.json({ error, code: 'invalid_input' }, 400);

/** `session` / `write` project access as a yes or no, for the folder rules. */
function mayOn(c: Context<AppEnv>, projectId: string) {
  return async (action: 'session' | 'write') => {
    try {
      return !!(await loadProjectForUser(c, projectId, action));
    } catch (error) {
      if (error instanceof HTTPException && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  };
}

export function registerProjectSearchRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/search',
      tags: ['projects'],
      summary: "Search the project's Files",
      description:
        "Finds files and folders in the project's Files by name and by text (Markdown, text, CSV, JSON, YAML, HTML, code; the first 256 KiB of each file). Name hits come first, then by text rank. A person sees only what their folder access lets them read; a session sees only the folders it may mount, including the ones that did not fit in its mount slots. A file written in the last ~20 s may not be found yet. `q`: 1-200 characters, every word must match (as a prefix). `path`: only below this folder. `limit`: 1-100, default 20. `next_cursor` is set while more hits may follow: pass it back as `cursor`.",
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        query: z.object({
          q: z.string().optional(),
          path: z.string().optional(),
          limit: z.string().optional(),
          cursor: z.string().optional(),
        }),
      },
      responses: { 200: json(SearchBody, 'Hits'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const query = parseSearchQuery(c.req.query('q'));
      if (!query) return invalid(c, `q is required: 1-${SEARCH_LIMITS.qMax} characters`);
      const limit = parseLimit(c.req.query('limit'));
      if (limit === null) return invalid(c, `limit must be a whole number from 1 to ${SEARCH_LIMITS.limitMax}`);
      const offset = decodeCursor(c.req.query('cursor'));
      if (offset === null) return invalid(c, 'cursor is not a next_cursor of this route');
      const under = c.req.query('path') ? normalizeDrivePath(c.req.query('path')) : null;
      if (c.req.query('path') && !under) return invalid(c, 'path is not a valid folder path');

      const tokenProjectId = c.get('tokenProjectId');
      if (tokenProjectId && tokenProjectId !== projectId) return c.json({ error: 'Not found' }, 404);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // Every project has a Drive where the platform stores one; without one there is nothing to search.
      const drive = await findProjectDrive(projectId);
      if (!drive) return c.json({ hits: [], next_cursor: null }, 200);
      const sessionId = callerKortixSessionId(c);
      const reader = sessionId
        ? await sessionSearchReader({ accountId: loaded.row.accountId, projectId, sessionId })
        : await personSearchReader(drive, loaded.userId, mayOn(c, projectId), async () =>
            usableDriveAgents((await actorFor(c, loaded.row.accountId)) ?? null, projectId),
          );
      const result = await searchDriveIndex({ driveId: drive.driveId, query, under, limit, offset, reader });
      return c.json({ hits: result.hits, next_cursor: result.nextCursor }, 200);
    },
  );
}
