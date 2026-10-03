import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { accessAtLeast } from '../../drives/access';
import {
  accessFor,
  changeSessionDrive,
  getDrive,
  isPersonalSession,
  readSessionDriveMounts,
} from '../../drives/service';
import { DriveStorageError } from '../../drives/volumes';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { getAccountMembership } from '../lib/git';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession, sessionAccessDenied } from '../lib/session-access';

// The drives a session's sandbox mounts, and changing them while it runs:
// attach any drive the caller may use, take one out, or switch one between
// read-only and read-write. A change applies to the running sandbox at once
// (Platinum hot attach/detach) and to every later sandbox of the session.

const SessionDriveSchema = z.object({
  driveId: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'agent', 'company']),
  mountPath: z.string(),
  readOnly: z.boolean(),
  subdir: z.string().optional(),
  fromAgents: z.boolean().optional(),
  role: z.enum(['me', 'agent', 'drive']).optional(),
  openConflicts: z.number(),
  ownerEmail: z.string().optional(),
});

const SessionDrivesBody = z.object({
  drives: z.array(SessionDriveSchema),
  /** True when the session is its owner's own (private, started by them): their drives mount in it. */
  personal: z.boolean(),
});

const Params = z.object({ projectId: z.string(), sessionId: z.string() });
const DriveParams = Params.extend({ driveId: z.string() });

async function sessionView(sessionId: string, callerId: string | undefined) {
  const [facts] = await db
    .select({
      createdBy: projectSessions.createdBy,
      visibility: projectSessions.visibility,
      origin: projectSessions.origin,
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
    })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const mounts = await readSessionDriveMounts(sessionId);
  return {
    facts: facts ?? null,
    body: {
      drives: mounts.map((m) => ({
        driveId: m.driveId,
        name: m.name,
        kind: m.kind,
        mountPath: m.mountPath,
        readOnly: m.readOnly,
        ...(m.subdir ? { subdir: m.subdir } : {}),
        ...(m.fromAgents ? { fromAgents: true } : {}),
        ...(m.role ? { role: m.role } : {}),
        openConflicts: m.openConflicts,
        ...(m.ownerEmail ? { ownerEmail: m.ownerEmail } : {}),
      })),
      personal: isPersonalSession(facts ?? null, callerId ?? null),
    },
  };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/** Shared preamble of every change: the project, the flag, the session, and lifecycle rights on it. */
async function forChange(c: any): Promise<{ loaded: Loaded; sessionId: string; userId: string } | Response> {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Drives require a signed-in user' }, 403);
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'drives');
  if (gate) return gate;
  const guard = await guardSession(c, loaded, sessionId, 'lifecycle');
  if (!guard.ok) return sessionAccessDenied(c, guard);
  return { loaded, sessionId, userId };
}

function storageFailure(c: any, err: unknown): Response {
  if (err instanceof DriveStorageError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

// GET /v1/projects/:projectId/sessions/:sessionId/drives
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/drives',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/drives',
    description: 'The drives the session’s sandbox mounts now, where, and with which access.',
    ...auth,
    request: { params: Params },
    responses: { 200: json(SessionDrivesBody, 'Session drives'), ...errors(400, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const guard = await guardSession(c, loaded, sessionId, 'read');
    if (!guard.ok) return sessionAccessDenied(c, guard);
    return c.json((await sessionView(sessionId, c.get('userId'))).body);
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/drives
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/drives',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/drives',
    description:
      'Attach a drive to the session: mounted in the running sandbox now, and in every later sandbox of the session. ' +
      'A personal drive attaches only to its holder’s own private session. `readOnly` defaults to false where the caller may write.',
    ...auth,
    request: {
      params: Params,
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ driveId: z.string(), readOnly: z.boolean().optional() }) } },
      },
    },
    responses: {
      200: json(SessionDrivesBody.extend({ live: z.boolean() }), 'Attached'),
      ...errors(400, 403, 404, 409, 503),
    },
  }),
  async (c: any) => {
    const pre = await forChange(c);
    if (pre instanceof Response) return pre;
    const { loaded, sessionId, userId } = pre;
    const body = c.req.valid('json') as { driveId: string; readOnly?: boolean };
    const drive = isUuid(body.driveId) ? await getDrive(body.driveId) : null;
    if (!drive || drive.accountId !== loaded.row.accountId) return c.json({ error: 'Drive not found' }, 404);
    const { facts } = await sessionView(sessionId, userId);
    const role = (await getAccountMembership(userId, drive.accountId))?.accountRole ?? null;
    // A company drive reaches the caller through a grant to them, or to this
    // session's project or agent.
    const access = await accessFor(drive, userId, role as any, {
      session: { projectId: loaded.row.projectId, agentName: facts?.agentName ?? 'default' },
    });
    if (access === 'none') return c.json({ error: 'Drive not found' }, 404);
    if (drive.kind === 'agent' && drive.projectId !== loaded.row.projectId) {
      const other = await loadProjectForUser(c, drive.projectId!, 'read').catch(() => null);
      if (!other) return c.json({ error: 'Drive not found' }, 404);
    }
    if (drive.kind === 'personal' && !isPersonalSession(facts, userId)) {
      return c.json({ error: 'A personal drive attaches only to private sessions you started yourself' }, 403);
    }
    // Your own drive comes back read-only with its From agents folder, as the
    // rules mount it; full write stays an explicit choice.
    const ownDrive = drive.kind === 'personal' && drive.isDefault && drive.ownerUserId === userId;
    const write = body.readOnly === false || (body.readOnly === undefined && !ownDrive && accessAtLeast(access, 'write'));
    if (write && !accessAtLeast(access, 'write')) return c.json({ error: 'You can only read this drive' }, 403);
    try {
      const result = await changeSessionDrive({
        accountId: loaded.row.accountId,
        projectId: loaded.row.projectId,
        sessionId,
        agentName: facts?.agentName ?? 'default',
        sessionOwner: facts?.createdBy ?? null,
        change: { type: 'attach', driveId: drive.driveId, by: userId, access: write ? 'write' : 'read' },
      });
      return c.json({ ...(await sessionView(sessionId, userId)).body, live: result.live });
    } catch (err) {
      return storageFailure(c, err);
    }
  },
);

// DELETE /v1/projects/:projectId/sessions/:sessionId/drives/:driveId
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}/drives/{driveId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/sessions/:sessionId/drives/:driveId',
    description: 'Take a drive out of the session: unmounted from the running sandbox (its last changes saved first) and from every later sandbox.',
    ...auth,
    request: { params: DriveParams },
    responses: { 200: json(SessionDrivesBody.extend({ live: z.boolean() }), 'Detached'), ...errors(400, 403, 404, 503) },
  }),
  async (c: any) => {
    const pre = await forChange(c);
    if (pre instanceof Response) return pre;
    const { loaded, sessionId, userId } = pre;
    const driveId = c.req.param('driveId');
    if (!isUuid(driveId)) return c.json({ error: 'Drive not found' }, 404);
    const { facts } = await sessionView(sessionId, userId);
    try {
      const result = await changeSessionDrive({
        accountId: loaded.row.accountId,
        projectId: loaded.row.projectId,
        sessionId,
        agentName: facts?.agentName ?? 'default',
        sessionOwner: facts?.createdBy ?? null,
        change: { type: 'detach', driveId },
      });
      return c.json({ ...(await sessionView(sessionId, userId)).body, live: result.live });
    } catch (err) {
      return storageFailure(c, err);
    }
  },
);

// PATCH /v1/projects/:projectId/sessions/:sessionId/drives/:driveId
projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sessions/{sessionId}/drives/{driveId}',
    tags: ['sessions'],
    summary: 'PATCH /:projectId/sessions/:sessionId/drives/:driveId',
    description:
      'Switch a drive between read-only and read-write for this session. `write` on your own drive is the per-session full-write opt-in: the agent then writes the whole drive, not only its From agents folder.',
    ...auth,
    request: {
      params: DriveParams,
      body: { required: true, content: { 'application/json': { schema: z.object({ access: z.enum(['read', 'write']) }) } } },
    },
    responses: { 200: json(SessionDrivesBody.extend({ live: z.boolean() }), 'Changed'), ...errors(400, 403, 404, 503) },
  }),
  async (c: any) => {
    const pre = await forChange(c);
    if (pre instanceof Response) return pre;
    const { loaded, sessionId, userId } = pre;
    const driveId = c.req.param('driveId');
    const { access: want } = c.req.valid('json') as { access: 'read' | 'write' };
    const drive = isUuid(driveId) ? await getDrive(driveId) : null;
    if (!drive || drive.accountId !== loaded.row.accountId) return c.json({ error: 'Drive not found' }, 404);
    const { facts } = await sessionView(sessionId, userId);
    if (want === 'write') {
      const role = (await getAccountMembership(userId, drive.accountId))?.accountRole ?? null;
      const access = await accessFor(drive, userId, role as any, {
        session: { projectId: loaded.row.projectId, agentName: facts?.agentName ?? 'default' },
      });
      if (!accessAtLeast(access, 'write')) {
        return c.json(
          { error: drive.kind === 'company' ? 'This drive is granted here read-only' : 'You can only read this drive' },
          403,
        );
      }
      if (drive.kind === 'personal' && !isPersonalSession(facts, userId)) {
        return c.json({ error: 'Only the drive’s owner can let an agent write it, in their own session' }, 403);
      }
    }
    try {
      const result = await changeSessionDrive({
        accountId: loaded.row.accountId,
        projectId: loaded.row.projectId,
        sessionId,
        agentName: facts?.agentName ?? 'default',
        sessionOwner: facts?.createdBy ?? null,
        change: { type: 'mode', driveId: drive.driveId, access: want, by: userId },
      });
      return c.json({ ...(await sessionView(sessionId, userId)).body, live: result.live });
    } catch (err) {
      return storageFailure(c, err);
    }
  },
);
