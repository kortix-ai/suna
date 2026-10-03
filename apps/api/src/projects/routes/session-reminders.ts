/**
 * Session reminders: scheduled prompts into one session (`lib/session-reminders.ts`).
 *
 * A reminder is a prompt sent later, so every route here takes the prompt route's
 * gates: `session` project access, `project.session.start`, per-agent run
 * authorization, and a visible, undeleted session. An agent session credential
 * may manage reminders on its OWN session only.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json, lenientBody } from '../../openapi';
import { readJsonObject } from '../../shared/http-body';
import { isUuid } from '../../shared/validate';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { serializeSession } from '../lib/serializers';
import { sessionIsTombstoned } from '../lib/access';
import {
  REMINDER_MAX_ACTIVE_PER_SESSION,
  countActiveSessionReminders,
  deleteSessionReminder,
  getSessionReminder,
  insertSessionReminderWithinCaps,
  listProjectReminders,
  listSessionReminders,
  reminderSpec,
  newReminderId,
  parseReminderDraft,
  serializeSessionReminder,
  setSessionReminderEnabled,
} from '../lib/session-reminders';

const ReminderSchema = z.object({}).passthrough();
const sessionParams = z.object({ projectId: z.string(), sessionId: z.string() });
const reminderParams = sessionParams.extend({ reminderId: z.string() });

/** Resolve the caller's right to schedule prompts into this session, or an error response. */
async function authorizeReminderSession(c: any) {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!isUuid(sessionId)) return { response: c.json({ error: 'Invalid session id' }, 400) };
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  const disabled = requireFeatureFlag(c, loaded.row.metadata, 'reminders');
  if (disabled) return { response: disabled };
  const agentCaller = isProjectSessionPrincipal(c);
  if (agentCaller && callerKortixSessionId(c) !== sessionId) {
    return {
      response: c.json({ error: 'An agent session can manage reminders on its own session only' }, 403),
    };
  }
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_SESSION_START,
  );
  const binding = callerKortixSessionId(c);
  const visible = await loadVisibleSession(loaded, sessionId, binding, binding);
  if (!visible) return { response: c.json({ error: 'Not found' }, 404) };
  const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata.deletedAt === 'string') {
    return { response: c.json({ error: 'Session is deleted' }, 409) };
  }
  return { projectId, sessionId, loaded, visible, agentCaller };
}

// GET /v1/projects/:projectId/reminders
//
// Every reminder on a session the caller can open, for the project Reminders
// page. Visibility is `loadVisibleSession`, once per distinct session, so the
// list can never show a reminder whose session the caller could not open.
// Pause/resume/remove go through the session-scoped routes below.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/reminders',
    tags: ['sessions'],
    summary: 'List reminders of a project',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.object({ reminders: z.array(ReminderSchema) }), 'Reminders on sessions the caller can open'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const disabled = requireFeatureFlag(c, loaded.row.metadata, 'reminders');
    if (disabled) return disabled;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const binding = callerKortixSessionId(c);
    const rows = await listProjectReminders(projectId);
    const sessionIds = [...new Set(rows.map((row) => row.sessionId as string))];
    const names = new Map<string, string | null>();
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const visible = await loadVisibleSession(loaded, sessionId, binding, binding);
        if (!visible || sessionIsTombstoned(visible.row)) return;
        names.set(sessionId, serializeSession(visible.row, { viewerId: loaded.userId }).name ?? null);
      }),
    );
    return c.json({
      reminders: rows
        .filter((row) => names.has(row.sessionId as string))
        .map((row) => ({ ...serializeSessionReminder(row), session_name: names.get(row.sessionId as string) })),
    });
  },
);

// GET /v1/projects/:projectId/sessions/:sessionId/reminders

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/reminders',
    tags: ['sessions'],
    summary: 'List reminders of a session',
    ...auth,
    request: { params: sessionParams },
    responses: {
      200: json(z.object({ reminders: z.array(ReminderSchema) }), 'Reminders on this session'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const access = await authorizeReminderSession(c);
    if ('response' in access) return access.response;
    const rows = await listSessionReminders(access.projectId, access.sessionId);
    return c.json({ reminders: rows.map(serializeSessionReminder) });
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/reminders

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/reminders',
    tags: ['sessions'],
    summary: 'Create a session reminder',
    ...auth,
    request: {
      params: sessionParams,
      body: { content: { 'application/json': { schema: lenientBody({
          prompt: z.string().openapi({ description: 'Text the session receives when the reminder fires.' }),
          name: z.string().optional().openapi({ description: 'Reminder name.' }),
          at: z.string().optional().openapi({ description: 'ISO-8601 instant for a one-off reminder. Give exactly one of at, in, every, cron.' }),
          in: z.string().optional().openapi({ description: 'Delay such as 30m, 24h, 2d.' }),
          every: z.string().optional().openapi({ description: 'Repeat interval such as 1h. Minimum applies.' }),
          cron: z.string().optional().openapi({ description: 'Cron expression for a repeating reminder.' }),
          timezone: z.string().optional().openapi({ description: 'IANA timezone for cron. Default UTC.' }),
        }) } } },
    },
    responses: {
      201: json(ReminderSchema, 'The created reminder'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    const access = await authorizeReminderSession(c);
    if ('response' in access) return access.response;
    const { projectId, sessionId, loaded, visible, agentCaller } = access;

    const now = new Date();
    const draft = parseReminderDraft(body, now);
    if ('error' in draft) return c.json({ error: draft.error }, 400);

    // Each fire re-prompts the session's own agent, so the caller must be
    // allowed to run it now, as with a prompt.
    await resolveAndAuthorizeAgent(c, loaded, projectId, null, visible.row.agentName);

    // Fast refusal; the locked insert below is the authoritative cap.
    if ((await countActiveSessionReminders(projectId, sessionId)) >= REMINDER_MAX_ACTIVE_PER_SESSION) {
      return c.json(
        { error: `This session already has ${REMINDER_MAX_ACTIVE_PER_SESSION} active reminders. Stop one first.` },
        409,
      );
    }

    const spec = reminderSpec({
      id: newReminderId(),
      sessionId,
      agent: visible.row.agentName ?? 'default',
      draft,
      now,
      // A person's reminder is their deferred prompt: the fire acts as them.
      promptAuthorUserId: agentCaller ? null : loaded.userId,
    });
    const inserted = await insertSessionReminderWithinCaps({
      projectId,
      spec,
      createdBy: loaded.userId,
      firstFireAt: draft.firstFireAt,
      now,
    });
    if ('error' in inserted) return c.json({ error: inserted.error }, 409);
    return c.json(serializeSessionReminder(inserted.row), 201);
  },
);

// PATCH /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId  { enabled }

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sessions/{sessionId}/reminders/{reminderId}',
    tags: ['sessions'],
    summary: 'Update a session reminder',
    ...auth,
    request: {
      params: reminderParams,
      body: { content: { 'application/json': { schema: lenientBody({
          enabled: z.boolean().openapi({ description: 'true resumes the reminder; false pauses it.' }),
        }) } } },
    },
    responses: {
      200: json(ReminderSchema, 'The updated reminder'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const body = await readJsonObject(c);
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled (boolean) is required' }, 400);
    }
    const access = await authorizeReminderSession(c);
    if ('response' in access) return access.response;
    const row = await getSessionReminder(access.projectId, access.sessionId, c.req.param('reminderId'));
    if (!row) return c.json({ error: 'Reminder not found' }, 404);
    if (
      body.enabled &&
      !row.enabled &&
      (await countActiveSessionReminders(access.projectId, access.sessionId)) >= REMINDER_MAX_ACTIVE_PER_SESSION
    ) {
      return c.json(
        { error: `This session already has ${REMINDER_MAX_ACTIVE_PER_SESSION} active reminders. Stop one first.` },
        409,
      );
    }
    const updated = await setSessionReminderEnabled(row, body.enabled, new Date());
    return c.json(serializeSessionReminder(updated));
  },
);

// DELETE /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}/reminders/{reminderId}',
    tags: ['sessions'],
    summary: 'Delete a session reminder',
    ...auth,
    request: { params: reminderParams },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Reminder deleted'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const access = await authorizeReminderSession(c);
    if ('response' in access) return access.response;
    const row = await getSessionReminder(access.projectId, access.sessionId, c.req.param('reminderId'));
    if (!row) return c.json({ error: 'Reminder not found' }, 404);
    await deleteSessionReminder(access.projectId, row.slug);
    return c.json({ ok: true });
  },
);
