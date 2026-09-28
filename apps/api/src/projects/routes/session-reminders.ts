/**
 * Session reminders: scheduled prompts into one session (`lib/session-reminders.ts`).
 *
 * A reminder is a prompt sent later, so every route here takes the prompt route's
 * gates: `session` project access, `project.session.start`, per-agent run
 * authorization, and a visible, undeleted session. An agent session credential
 * may manage reminders on its OWN session only.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { readJsonObject } from '../../shared/http-body';
import { isUuid } from '../../shared/validate';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { AnyObject, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { clearSessionOnBehalfOfForPrompt } from '../lib/on-behalf-of';
import {
  REMINDER_MAX_ACTIVE_PER_SESSION,
  countActiveSessionReminders,
  deleteSessionReminder,
  getSessionReminder,
  insertSessionReminder,
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

// GET /v1/projects/:projectId/sessions/:sessionId/reminders

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/reminders',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/reminders',
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
    summary: 'POST /:projectId/sessions/:sessionId/reminders',
    ...auth,
    request: {
      params: sessionParams,
      body: { content: { 'application/json': { schema: AnyObject } } },
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

    if ((await countActiveSessionReminders(projectId, sessionId)) >= REMINDER_MAX_ACTIVE_PER_SESSION) {
      return c.json(
        { error: `This session already has ${REMINDER_MAX_ACTIVE_PER_SESSION} active reminders. Stop one first.` },
        409,
      );
    }

    // A reminder is a prompt authored now and delivered later. The delivery never
    // clears `on_behalf_of` (`channelPrompterForOnBehalfOf`), so a human other
    // than the session's `on_behalf_of` clears it here, as the prompt route does.
    if (!agentCaller) {
      await clearSessionOnBehalfOfForPrompt({
        accountId: loaded.row.accountId,
        sessionId,
        prompterUserId: loaded.userId,
      });
    }

    const spec = reminderSpec({
      id: newReminderId(),
      sessionId,
      agent: visible.row.agentName ?? 'default',
      draft,
      now,
    });
    const row = await insertSessionReminder({
      projectId,
      spec,
      createdBy: loaded.userId,
      firstFireAt: draft.firstFireAt,
      now,
    });
    return c.json(serializeSessionReminder(row), 201);
  },
);

// PATCH /v1/projects/:projectId/sessions/:sessionId/reminders/:reminderId  { enabled }

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sessions/{sessionId}/reminders/{reminderId}',
    tags: ['sessions'],
    summary: 'PATCH /:projectId/sessions/:sessionId/reminders/:reminderId',
    ...auth,
    request: {
      params: reminderParams,
      body: { content: { 'application/json': { schema: AnyObject } } },
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
    summary: 'DELETE /:projectId/sessions/:sessionId/reminders/:reminderId',
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
