import { createRoute, z } from '@hono/zod-openapi';
import { isCallersPersonalSession, readSessionDriveMounts, readSkippedSessionDrives } from '../../drives/service';
import { auth, errors, json } from '../../openapi';
import { isUuid } from '../../shared/validate';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { guardSession, sessionAccessDenied } from '../lib/http-session-access';

// The folders of the project's Files a session's sandbox mounts. What mounts
// follows folder access (who the session acts for: its agent, the project,
// and in a personal session its person); sharing a folder in Files changes it,
// for the running sandbox at once and for every later one.

const SessionDriveSchema = z.object({
  driveId: z.string(),
  /** The folder, for people: "Company", "Users / ana". */
  name: z.string(),
  kind: z.literal('project'),
  mountPath: z.string(),
  readOnly: z.boolean(),
  /** The folder of the drive this mount is. */
  subdir: z.string(),
  /** `me`: the session owner's own folder, their desktop. */
  role: z.enum(['me', 'drive']).optional(),
  openConflicts: z.number(),
});

const SessionDrivesBody = z.object({
  drives: z.array(SessionDriveSchema),
  /** True when the session is its owner's own (private, started by them): their folder mounts in it. */
  personal: z.boolean(),
  /**
   * Folders the session should have that its sandbox does not mount. `reason`:
   * absent = past its mount slots; `region` / `moving` = the files live, or
   * were moving, elsewhere; `unavailable` = storage refused the mount when the
   * sandbox started, and it mounts as soon as storage can; `too_large` = the
   * folder is larger than a folder mount allows. `detail` is storage's reason.
   */
  skipped: z.array(
    z.object({
      driveId: z.string(),
      name: z.string(),
      reason: z.enum(['region', 'moving', 'unavailable', 'too_large']).optional(),
      detail: z.string().optional(),
      /** For `too_large`: what the folder holds, and the largest folder a session mounts. */
      bytes: z.number().optional(),
      maxBytes: z.number().optional(),
    }),
  ),
  /** What to tell people about `skipped`, or null when every folder fit. */
  skippedMessage: z.string().nullable(),
});

const Params = z.object({ projectId: z.string(), sessionId: z.string() });

async function sessionView(sessionId: string, callerId: string | undefined) {
  const [mounts, skipped] = await Promise.all([readSessionDriveMounts(sessionId), readSkippedSessionDrives(sessionId)]);
  return {
    drives: mounts.map((m) => ({
      driveId: m.driveId,
      name: m.name,
      kind: 'project' as const,
      mountPath: m.mountPath,
      readOnly: m.readOnly,
      subdir: m.subdir,
      ...(m.role ? { role: m.role } : {}),
      openConflicts: m.openConflicts,
    })),
    personal: await isCallersPersonalSession(sessionId, callerId ?? null),
    skipped: skipped.skipped.map((d) => ({
      driveId: d.driveId,
      name: d.name,
      ...(d.reason ? { reason: d.reason } : {}),
      ...(d.detail ? { detail: d.detail } : {}),
      ...(typeof d.bytes === 'number' ? { bytes: d.bytes } : {}),
      ...(typeof d.maxBytes === 'number' ? { maxBytes: d.maxBytes } : {}),
    })),
    skippedMessage: skipped.message,
  };
}

export function registerSessionDrivesRoutes(): void {
  // GET /v1/projects/:projectId/sessions/:sessionId/drives
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/drives',
      tags: ['sessions'],
      summary: 'List the folders a session mounts',
      description: 'The folders of the project’s Files the session’s sandbox mounts now, where, and with which access.',
      ...auth,
      request: { params: Params },
      responses: { 200: json(SessionDrivesBody, 'Session drives'), ...errors(400, 404) },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const guard = await guardSession(c, loaded, sessionId, 'read');
      if (!guard.ok) return sessionAccessDenied(c, guard) as never;
      return c.json(await sessionView(sessionId, c.get('userId')));
    },
  );
}
