/**
 * POST /v1/projects/:projectId/monitors/ingest — the monitor event intake.
 *
 * The ONLY caller is the monitor runner inside the project's own monitor box,
 * authenticating with that box's sandbox token. A monitor box has no
 * `session_sandboxes` row, so the token is scoped against
 * `project_monitor_boxes` (sandbox id ∧ project ∧ account ∧ live status) —
 * see docs/specs/2026-08-12-monitors.md §"Security model". No new authority is
 * granted: the box can only append events to its own project's log.
 *
 * Accepted events are appended to `project_monitor_events`, which doubles as
 * the fire queue; the observer drains it (../lib/monitor-observer.ts).
 */

import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { AnyObject, projectsApp } from '../lib/app';
import { parseMonitorIngestBody } from '../lib/monitor-events';
import { ingestMonitorEvents, loadMonitorBoxForToken } from '../lib/monitor-ingest';
import { readBody } from '../lib/serializers';

const MonitorIngestResultSchema = z.object({
  accepted: z.number(),
  deduped: z.number(),
  suppressed: z.number(),
});

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/monitors/ingest',
    tags: ['projects'],
    summary: 'Append monitor events from the project monitor box',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      202: json(MonitorIngestResultSchema, 'Events appended'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');

    // Sandbox token ONLY. A human/PAT caller has no business writing into the
    // event log — the log's whole value is that its rows came from the box.
    const authType = c.get('authType') as string | undefined;
    const apiKeyType = c.get('apiKeyType') as string | undefined;
    const accountId = c.get('accountId') as string | undefined;
    const sandboxId = c.get('sandboxId') as string | undefined;
    if (authType !== 'apiKey' || apiKeyType !== 'sandbox' || !accountId || !sandboxId) {
      return c.json({ error: 'monitor ingest requires a sandbox token' }, 403);
    }

    const box = await loadMonitorBoxForToken({ projectId, accountId, sandboxId });
    if (!box) {
      return c.json({ error: 'sandbox token is not scoped to this project monitor box' }, 403);
    }

    const [project] = await db
      .select({ projectId: projects.projectId, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, project.metadata, 'monitors');
    if (gate) return gate;

    const parsed = parseMonitorIngestBody(await readBody(c));
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);

    // Events from a superseded boot must not fire: `seq` restarts per epoch, so
    // a resurrected old runner would replay sequence numbers the current epoch
    // is about to use.
    if (parsed.boxEpoch !== box.boxEpoch) {
      return c.json({ error: 'box_epoch is stale', code: 'stale_box_epoch' }, 409);
    }

    const result = await ingestMonitorEvents({
      projectId,
      boxEpoch: parsed.boxEpoch,
      events: parsed.events,
    });
    return c.json(result, 202);
  },
);
