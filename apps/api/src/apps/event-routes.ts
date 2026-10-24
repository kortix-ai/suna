/**
 * POST /v1/projects/:projectId/apps/:appId/events — an App emits events that
 * fire the project's `type: app` triggers naming it (./events.ts).
 *
 * Authenticated by the App's own `KORTIX_APP_TOKEN`, never a user credential,
 * so it is mounted BEFORE projectsApp, whose `/*` supabaseAuth would 401 it
 * (app.ts).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { ingestAppEvents, parseAppEventsBody } from '../projects/surface';
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
      const token = bearerToken(c.req.header('authorization'));
      if (!token || !appEventTokenMatches(appId, token)) {
        return c.json({ error: 'Send the App token: Authorization: Bearer $KORTIX_APP_TOKEN', code: 'app_token_invalid' }, 401);
      }
      const app = await scopedApp(projectId, appId);
      if (!app) return c.json({ error: 'Not found' }, 404);
      const events = parseAppEventsBody(await readJsonObject(c));
      if ('error' in events) return c.json({ error: events.error }, 400);
      const result = await ingestAppEvents({ projectId, appId, appSlug: app.slug, events });
      return c.json(result, 202);
    },
  );
}
