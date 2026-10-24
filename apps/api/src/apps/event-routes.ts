/**
 * The routes an App calls with its own `KORTIX_APP_TOKEN`:
 *   POST   /v1/projects/:projectId/apps/:appId/events        emit events that fire `type: app` triggers (./events.ts)
 *   POST   /v1/projects/:projectId/apps/:appId/runs          ask to be called later: runAfter / runAt (../projects/lib/app-runs.ts)
 *   DELETE /v1/projects/:projectId/apps/:appId/runs/:runId   cancel a pending run
 *
 * Authenticated by the App's own `KORTIX_APP_TOKEN`, never a user credential,
 * so it is mounted BEFORE projectsApp, whose `/*` supabaseAuth would 401 it
 * (app.ts).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { cancelAppRun, ingestAppEvents, insertAppRun, parseAppEventsBody } from '../projects/surface';
import { scheduleDelaySeconds } from './events';
import { bearerToken } from '../shared/bearer-token';
import { readJsonObject } from '../shared/http-body';
import { appEventTokenMatches } from './events';
import { scopedApp } from './route-access';

export const appEventsApp = makeOpenApiApp();

const AppEvent = z.object({
  name: z.string().openapi({ description: 'Event name, such as reply.received. Filter on it with `event.name`.' }),
  data: z.record(z.string(), z.any()).optional().openapi({ description: 'Event data. The prompt reads it as {{ event.data.<field> }}.' }),
  id: z.string().optional().openapi({ description: 'Your id for the event. The same id fires a trigger once.' }),
});

const RunRequest = z.object({
  run_after: z.union([z.string(), z.number()]).optional().openapi({ description: 'Delay: a duration such as 30s, 10m, 2h, 7d, or seconds. Send this or run_at.' }),
  run_at: z.string().optional().openapi({ description: 'ISO-8601 instant, at most 366 days ahead. Send this or run_after.' }),
  path: z.string().optional().openapi({ description: 'Path Kortix calls on the App. Default /.' }),
  method: z.enum(['POST', 'GET']).optional().openapi({ description: 'Default POST.' }),
  payload: z.record(z.string(), z.any()).optional().openapi({ description: 'JSON body of a POST call, at most 64 KiB.' }),
});
const MAX_RUN_AHEAD_MS = 366 * 86_400_000;

/** The App behind the token, or the response to answer. */
async function tokenApp(authorization: string | undefined, projectId: string, appId: string): Promise<{ slug: string } | 401 | 404> {
  const token = bearerToken(authorization);
  if (!token || !appEventTokenMatches(appId, token)) return 401;
  return (await scopedApp(projectId, appId)) ?? 404;
}
const TOKEN_ERROR = { error: 'Send the App token: Authorization: Bearer $KORTIX_APP_TOKEN', code: 'app_token_invalid' } as const;

export function registerAppEventRoutes(): void {
  appEventsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/events', tags: ['apps'],
      summary: 'Emit App events',
      description:
        'Fires every enabled `type: app` trigger that names this App. Send one event, or `{ "events": [...] }` (at most 50). ' +
        'Authenticate with `Authorization: Bearer $KORTIX_APP_TOKEN`; every App machine has it, with `KORTIX_APP_EVENTS_URL`. ' +
        '`triggers` is how many triggers matched: 0 is not an error.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: AppEvent.or(z.object({ events: z.array(AppEvent) })) } } },
      },
      responses: {
        202: json(z.object({ triggers: z.number(), accepted: z.number(), deduped: z.number(), suppressed: z.number() }), 'Events appended'),
        ...errors(400, 401, 404),
      },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const app = await tokenApp(c.req.header('authorization'), projectId, appId);
      if (app === 401) return c.json(TOKEN_ERROR, 401);
      if (app === 404) return c.json({ error: 'Not found' }, 404);
      const events = parseAppEventsBody(await readJsonObject(c));
      if ('error' in events) return c.json({ error: events.error }, 400);
      const result = await ingestAppEvents({ projectId, appId, appSlug: app.slug, events });
      return c.json(result, 202);
    },
  );

  appEventsApp.openapi(
    createRoute({
      method: 'post', path: '/{projectId}/apps/{appId}/runs', tags: ['apps'], summary: 'Ask Kortix to call the App later',
      description:
        'Kortix calls `method path` on this App once, after `run_after` or at `run_at`, waking it first. The call goes through ' +
        'the trigger engine: a failed call (no answer, 429 or 5xx) is retried. At most 1000 pending runs per App. Authenticate with `$KORTIX_APP_TOKEN`.',
      ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid() }), body: { content: { 'application/json': { schema: RunRequest } } } },
      responses: { 201: json(z.object({ run_id: z.string(), run_at: z.string() }), 'Scheduled'), ...errors(400, 401, 404, 409) },
    }),
    async (c) => {
      const { projectId, appId } = c.req.valid('param');
      const app = await tokenApp(c.req.header('authorization'), projectId, appId);
      if (app === 401) return c.json(TOKEN_ERROR, 401);
      if (app === 404) return c.json({ error: 'Not found' }, 404);
      const body = RunRequest.safeParse(await readJsonObject(c));
      if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? 'invalid body' }, 400);
      const { run_after, run_at, path = '/', method = 'POST', payload = {} } = body.data;
      if ((run_after === undefined) === (run_at === undefined)) return c.json({ error: 'send exactly one of run_after or run_at' }, 400);
      const when = run_at !== undefined ? new Date(run_at) : new Date(Date.now() + scheduleDelaySeconds(run_after!) * 1000);
      if (Number.isNaN(when.getTime())) return c.json({ error: 'run_after is a duration such as 30s, 10m, 2h or 7d; run_at is an ISO-8601 instant' }, 400);
      if (when.getTime() - Date.now() > MAX_RUN_AHEAD_MS) return c.json({ error: 'a run is at most 366 days ahead' }, 400);
      if (!path.startsWith('/') || /[\r\n]/.test(path) || path.length > 2048) return c.json({ error: 'path must start with /' }, 400);
      if (JSON.stringify(payload).length > 64 * 1024) return c.json({ error: 'payload is at most 64 KiB' }, 400);
      const run = await insertAppRun({ projectId, app: app.slug, runAt: when, method, path, payload });
      if ('error' in run) return c.json({ error: run.error }, 409);
      return c.json({ run_id: run.runId, run_at: run.runAt.toISOString() }, 201);
    },
  );

  appEventsApp.openapi(
    createRoute({
      method: 'delete', path: '/{projectId}/apps/{appId}/runs/{runId}', tags: ['apps'], summary: 'Cancel a pending App run',
      description: 'Cancels a run this App scheduled that has not fired. Authenticate with `$KORTIX_APP_TOKEN`.',
      ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), appId: z.string().uuid(), runId: z.string() }) },
      responses: { 200: json(z.object({ cancelled: z.literal(true) }), 'Cancelled'), ...errors(401, 404) },
    }),
    async (c) => {
      const { projectId, appId, runId } = c.req.valid('param');
      const app = await tokenApp(c.req.header('authorization'), projectId, appId);
      if (app === 401) return c.json(TOKEN_ERROR, 401);
      if (app === 404 || !(await cancelAppRun(projectId, app.slug, runId))) return c.json({ error: 'Not found' }, 404);
      return c.json({ cancelled: true as const }, 200);
    },
  );
}
