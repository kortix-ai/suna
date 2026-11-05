/**
 * The App's event log, read by people and agents (not by the App):
 *
 *   GET /v1/projects/:projectId/apps/:appId/events   project.app.deploy (the operations view)
 *
 * One row per trigger an event reached, plus one `unmatched` row for an event
 * no enabled trigger listened to. It answers "did my App post, and what came
 * of it": fired (with the session), skipped (and why), suppressed, failed,
 * pending. The App itself posts to the same path with its own token
 * (./event-routes.ts); a GET never reaches that router.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import { APP_EVENT_LOG_STATUSES, decodeAppEventCursor, listAppEventLog, projectsApp } from '../projects/surface';
import { authorizedProject, visibleApp } from './route-access';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const AppEventLogEntry = z
  .object({
    log_id: z.string(),
    name: z.string().nullable().openapi({ description: 'The event name the App sent.' }),
    id: z.string().nullable().openapi({ description: "The App's own id for the event; the same id fires a trigger once." }),
    data: z.record(z.string(), z.any()).nullable(),
    truncated: z.boolean().openapi({ description: 'The event was over 8 KiB: `data` is null and `raw` holds its head.' }),
    raw: z.string().nullable(),
    trigger: z.string().nullable().openapi({ description: 'The trigger this row belongs to; null when no trigger listened.' }),
    status: z.enum(APP_EVENT_LOG_STATUSES).openapi({
      description:
        '`pending` waits for the drain; `fired` started or continued a session; `skipped` did not run (see `reason`: filter, ' +
        'disabled trigger, paused project, run cap); `suppressed` came past the trigger\'s rate limit; `failed` dead-lettered ' +
        'after 5 attempts; `unmatched` reached no enabled trigger.',
    }),
    reason: z.string().nullable(),
    session_id: z.string().nullable(),
    attempts: z.number(),
    emitted_at: z.string(),
    received_at: z.string(),
    fired_at: z.string().nullable(),
  })
  .openapi('KortixAppEventLogEntry');

const AppEventLog = z
  .object({ events: z.array(AppEventLogEntry), next_cursor: z.string().nullable() })
  .openapi('KortixAppEventLog');

export function registerAppEventLogRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{projectId}/apps/{appId}/events', tags: ['apps'], summary: "List an App's events", ...auth,
      description:
        'The events the App posted in the last 30 days, newest first, with what came of each: one row per trigger the event ' +
        'reached, or one `unmatched` row when no enabled trigger listens to the App. Needs project.app.deploy.',
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        query: z.object({
          limit: z.string().optional().openapi({ description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}.` }),
          cursor: z.string().optional().openapi({ description: '`next_cursor` of the previous page.' }),
          status: z.enum(APP_EVENT_LOG_STATUSES).optional(),
          trigger: z.string().max(128).optional().openapi({ description: 'One trigger slug.' }),
        }),
      },
      responses: { 200: json(AppEventLog, 'Events, newest first'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const query = c.req.valid('query');
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return c.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, 400);
      }
      const cursor = query.cursor ? decodeAppEventCursor(query.cursor) : null;
      if (query.cursor && !cursor) return c.json({ error: 'cursor is not a next_cursor of this list' }, 400);
      const page = await listAppEventLog({ projectId, appId, limit, cursor, status: query.status, trigger: query.trigger });
      return c.json(page, 200);
    },
  );
}
