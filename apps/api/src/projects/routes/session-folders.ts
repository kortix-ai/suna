/**
 * Sidebar session folders — CRUD + session assignment.
 *
 * Folders organize a project's sessions into named silos in the sidebar. See
 * ../lib/session-folders.ts for the visibility model ('private' folders are
 * the creator's own; 'project' folders are shared and their sessions inherit
 * project-wide visibility). Assignment lives at
 * PUT /:projectId/sessions/:sessionId/folder so a session move is one call.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, sessionFolders } from '@kortix/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { roleAllows } from '../access';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, OkSchema, SessionFolderSchema, SessionSchema, projectsApp } from '../lib/app';
import {
  canManageFolder,
  isFolderVisibleTo,
  parseFolderName,
  parseFolderVisibility,
  serializeSessionFolder,
} from '../lib/session-folders';
import { UUID_V4_REGEX, hasOwn, readBody, serializeSession } from '../lib/serializers';

// GET /v1/projects/:projectId/session-folders

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/session-folders',
    tags: ['sessions'],
    summary: 'GET /:projectId/session-folders',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.array(SessionFolderSchema), 'Folders visible to the viewer'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const rows = await db
      .select()
      .from(sessionFolders)
      .where(eq(sessionFolders.projectId, projectId))
      .orderBy(asc(sessionFolders.position), asc(sessionFolders.createdAt));

    const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
    return c.json(
      rows
        .filter((row) => isFolderVisibleTo(row, loaded.userId))
        .map((row) => serializeSessionFolder(row, { viewerId: loaded.userId, canManageProject })),
    );
  },
);

// POST /v1/projects/:projectId/session-folders

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/session-folders',
    tags: ['sessions'],
    summary: 'POST /:projectId/session-folders',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(SessionFolderSchema, 'The created folder'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const name = parseFolderName(body.name);
    if (!name) return c.json({ error: 'name is required (≤120 chars)' }, 400);
    const visibility = hasOwn(body, 'visibility')
      ? parseFolderVisibility(body.visibility)
      : 'private';
    if (!visibility) return c.json({ error: 'visibility must be private|project' }, 400);

    // New folders append after the viewer's existing ones.
    const [last] = await db
      .select({ position: sessionFolders.position })
      .from(sessionFolders)
      .where(eq(sessionFolders.projectId, projectId))
      .orderBy(desc(sessionFolders.position))
      .limit(1);

    const [row] = await db
      .insert(sessionFolders)
      .values({
        projectId,
        accountId: loaded.row.accountId,
        name,
        visibility,
        position: (last?.position ?? -1) + 1,
        createdBy: loaded.userId,
      })
      .returning();

    const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
    return c.json(
      serializeSessionFolder(row, { viewerId: loaded.userId, canManageProject }),
      201,
    );
  },
);

// PATCH /v1/projects/:projectId/session-folders/:folderId

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/session-folders/{folderId}',
    tags: ['sessions'],
    summary: 'PATCH /:projectId/session-folders/:folderId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), folderId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SessionFolderSchema, 'The updated folder'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const folderId = c.req.param('folderId');
    if (!UUID_V4_REGEX.test(folderId)) return c.json({ error: 'Invalid folder id' }, 400);

    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [existing] = await db
      .select()
      .from(sessionFolders)
      .where(and(eq(sessionFolders.folderId, folderId), eq(sessionFolders.projectId, projectId)));
    if (!existing || !isFolderVisibleTo(existing, loaded.userId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
    if (!canManageFolder(existing, loaded.userId, canManageProject)) {
      return c.json({ error: 'Only the folder owner or a project manager can edit it' }, 403);
    }

    const updates: Partial<typeof sessionFolders.$inferInsert> = { updatedAt: new Date() };
    if (hasOwn(body, 'name')) {
      const name = parseFolderName(body.name);
      if (!name) return c.json({ error: 'name must be a non-empty string (≤120 chars)' }, 400);
      updates.name = name;
    }
    if (hasOwn(body, 'visibility')) {
      const visibility = parseFolderVisibility(body.visibility);
      if (!visibility) return c.json({ error: 'visibility must be private|project' }, 400);
      updates.visibility = visibility;
    }
    if (hasOwn(body, 'position')) {
      const position = body.position;
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
        return c.json({ error: 'position must be a non-negative integer' }, 400);
      }
      updates.position = position;
    }

    const [row] = await db
      .update(sessionFolders)
      .set(updates)
      .where(and(eq(sessionFolders.folderId, folderId), eq(sessionFolders.projectId, projectId)))
      .returning();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(serializeSessionFolder(row, { viewerId: loaded.userId, canManageProject }));
  },
);

// DELETE /v1/projects/:projectId/session-folders/:folderId
// Deleting a folder unfiles its sessions (FK SET NULL) — it never deletes them.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/session-folders/{folderId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/session-folders/:folderId',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), folderId: z.string() }),
    },
    responses: {
      200: json(OkSchema, 'Deleted'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const folderId = c.req.param('folderId');
    if (!UUID_V4_REGEX.test(folderId)) return c.json({ error: 'Invalid folder id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const [existing] = await db
      .select()
      .from(sessionFolders)
      .where(and(eq(sessionFolders.folderId, folderId), eq(sessionFolders.projectId, projectId)));
    if (!existing || !isFolderVisibleTo(existing, loaded.userId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const canManageProject = roleAllows(loaded.effectiveRole, 'manage');
    if (!canManageFolder(existing, loaded.userId, canManageProject)) {
      return c.json({ error: 'Only the folder owner or a project manager can delete it' }, 403);
    }

    await db
      .delete(sessionFolders)
      .where(and(eq(sessionFolders.folderId, folderId), eq(sessionFolders.projectId, projectId)));
    return c.json({ ok: true });
  },
);

// PUT /v1/projects/:projectId/sessions/:sessionId/folder
// Move a session into a folder (or unfile it with folder_id: null).

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/folder',
    tags: ['sessions'],
    summary: 'PUT /:projectId/sessions/:sessionId/folder',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SessionSchema, 'The updated session'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readBody(c);
    if (!hasOwn(body, 'folder_id')) return c.json({ error: 'folder_id is required (uuid or null)' }, 400);
    const folderId = body.folder_id;
    if (folderId !== null && (typeof folderId !== 'string' || !UUID_V4_REGEX.test(folderId))) {
      return c.json({ error: 'folder_id must be a uuid or null' }, 400);
    }

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const visible = await loadVisibleSession(loaded, sessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    if (folderId) {
      const [folder] = await db
        .select()
        .from(sessionFolders)
        .where(and(eq(sessionFolders.folderId, folderId), eq(sessionFolders.projectId, projectId)));
      if (!folder || !isFolderVisibleTo(folder, loaded.userId)) {
        return c.json({ error: 'Folder not found' }, 404);
      }
    }

    const [row] = await db
      .update(projectSessions)
      .set({ folderId, updatedAt: new Date() })
      .where(and(
        eq(projectSessions.sessionId, sessionId),
        eq(projectSessions.projectId, projectId),
        eq(projectSessions.accountId, loaded.row.accountId),
      ))
      .returning();
    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json(serializeSession(row, {
      grants: visible.grants,
      viewerId: loaded.userId,
      canManageProject: visible.canManageProject,
    }));
  },
);
