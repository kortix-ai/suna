/**
 * The App's event log, read by people and agents (not by the App):
 *
 *   GET  /v1/projects/:projectId/apps/:appId/events        project.app.deploy (the operations view)
 *   POST /v1/projects/:projectId/apps/:appId/events/test   project.app.deploy: a test event on the real path
 *
 * One row per trigger an event reached, plus one `unmatched` row for an event
 * no enabled trigger listened to. It answers "did my App post, and what came
 * of it": fired (with the session), skipped (and why), suppressed, failed,
 * pending. The App itself posts to the same path with its own token
 * (./event-routes.ts); a GET never reaches that router.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import {
  APP_EVENT_LOG_STATUSES,
  asTestEvents,
  decodeAppEventCursor,
  ingestAppEvents,
  listAppEventLog,
  parseAppEventsBody,
  projectsApp,
} from '../projects/surface';
import { readJsonObject } from '../shared/http-body';
import { authorizedProject, visibleApp } from './route-access';
import { appEventRateLimited } from '../middleware/rate-limit';

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
    test: z.boolean().openapi({ description: 'Sent through the test route by a person or agent, not by the App.' }),
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

const TestEvent = z.object({
  name: z.string().openapi({ description: 'Event name, such as status.changed.' }),
  data: z.record(z.string(), z.any()).optional(),
  id: z.string().optional().openapi({ description: 'Prefixed with test- when it does not start with it.' }),
});

const TestEventResult = z
  .object({
    triggers: z.number(),
    accepted: z.number(),
    deduped: z.number(),
    suppressed: z.number(),
    unmatched: z.number(),
    hint: z.string().optional(),
    ids: z.array(z.string()).openapi({ description: 'The test ids, in the order sent.' }),
  })
  .openapi('KortixAppTestEventResult');

const AppEventLog = z
  .object({ events: z.array(AppEventLogEntry), next_cursor: z.string().nullable() })
  .openapi('KortixAppEventLog');

export function registerAppEventLogRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get', path: '/{workspaceId}/apps/{appId}/events', tags: ['apps'], summary: "List an App's events", ...auth,
      description:
        'The events the App posted in the last 30 days, newest first, with what came of each: one row per trigger the event ' +
        'reached, or one `unmatched` row when no enabled trigger listens to the App. Needs project.app.deploy.',
      request: {
        params: z.object({ workspaceId: z.string().uuid(), appId: z.string().uuid() }),
        query: z.object({
          limit: z.string().optional().openapi({ description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}.` }),
          cursor: z.string().optional().openapi({ description: '`next_cursor` of the previous page.' }),
          status: z.enum(APP_EVENT_LOG_STATUSES).optional(),
          trigger: z.string().max(128).optional().openapi({ description: 'One trigger slug.' }),
          id: z.string().max(256).optional().openapi({ description: "One event id, as the App sent it (a test event's starts with test-)." }),
        }),
      },
      responses: { 200: json(AppEventLog, 'Events, newest first'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { workspaceId: projectId, appId } = c.req.valid('param');
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
      const page = await listAppEventLog({ projectId, appId, limit, cursor, status: query.status, trigger: query.trigger, eventId: query.id });
      return c.json(page, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post', path: '/{workspaceId}/apps/{appId}/events/test', tags: ['apps'], summary: 'Send a test App event', ...auth,
      description:
        'Sends events as if the App posted them, through the same log, limits and triggers, to prove the wiring. Every id ' +
        'starts with `test-` (one is made when none is sent), so a real event with the same id still fires later; the prompt ' +
        'reads `event.test` as true and starts with a TEST preamble. `ids` lists the ids to look up in the log ' +
        '(`GET` the events with `id=`). Needs project.app.deploy.',
      request: {
        params: z.object({ workspaceId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: TestEvent.or(z.object({ events: z.array(TestEvent) })) } } },
      },
      responses: { 202: json(TestEventResult, 'Events appended'), ...errors(400, 403, 404, 429) },
    }),
    async (c) => {
      const { workspaceId: projectId, appId } = c.req.valid('param');
      const loaded = await authorizedProject(c, projectId, 'deploy');
      if (loaded instanceof Response) return loaded;
      const app = await visibleApp(projectId, appId, loaded.userId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      // Test events share the App's request budget, charged after authorization.
      const limited = appEventRateLimited(c, projectId, appId);
      if (limited) {
        return c.json({ error: 'This App sent too many requests this minute. Retry shortly.', code: 'rate_limit_exceeded', retry_after_seconds: limited.retryAfterSeconds }, 429);
      }
      const parsed = parseAppEventsBody(await readJsonObject(c));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      const events = asTestEvents(parsed);
      const result = await ingestAppEvents({ projectId, appId, appSlug: app.slug, events, test: true });
      return c.json({ ...result, ids: events.map((event) => event.id!) }, 202);
    },
  );
}
