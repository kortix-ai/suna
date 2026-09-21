/**
 * Config release routes (docs/specs/config-releases.md, "Routes").
 *
 * POST /v1/projects/:projectId/sessions/:sessionId/config-release
 *   The daemon posts its workspace report and receives the desired release
 *   descriptor. Callers: the session's own sandbox token, or a project member
 *   who can read that session.
 *
 * GET /v1/projects/:projectId/config-archives/:configTreeId
 *   The config archive. `302` to a signed store URL when the storage host is
 *   public, streamed `application/gzip` otherwise. Callers: a sandbox token of
 *   a session with repository access in that project, or a human with
 *   `project.file.read`.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../iam';
import { isSessionSandboxCredential } from '../middleware/session-sandbox-credential';
import { auth, errors, json } from '../openapi';
import { resolveCommitSha } from '../projects/git/commits';
import { invalidateProjectMirror, refreshMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  projectCapabilityAllowed,
} from '../projects/lib/access';
import { projectsApp } from '../projects/lib/app';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { sandboxTokenMayActOnSession } from '../projects/lib/sandbox-token-session';
import { repositoryAccessFromSessionMetadata } from '../projects/lib/session-sandbox-metadata';
import { UUID_V4_REGEX } from '../projects/lib/serializers';
import { db } from '../shared/db';
import {
  buildConfigRelease,
  toDescriptor,
  type ConfigReleaseVariant,
} from './builder';
import { ConfigReleaseRequestSchema, decideConfigMode } from './mode';
import { serveConfigArchive } from './serve-archive';

const HEX40 = /^[0-9a-f]{40}$/;

interface ProjectRow {
  projectId: string;
  accountId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string | null;
}

interface SessionRow {
  baseRef: string | null;
  agentName: string | null;
  metadata: unknown;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404; error: string };

function gitProject(row: ProjectRow): GitBackedProject {
  return {
    projectId: row.projectId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    manifestPath: row.manifestPath ?? 'kortix.yaml',
    gitAuthToken: null,
  };
}

/**
 * The live session a sandbox token belongs to, in this project. The token
 * must be the session's own credential (`sandbox_id == session_id`), and the
 * sandbox row must be `provisioning` or `active`. Same checks as the audit
 * ingestion route.
 */
async function sandboxSession(
  c: Context,
  projectId: string,
  sessionId: string | null,
): Promise<Resolved<{ project: ProjectRow; session: SessionRow; sessionId: string }>> {
  const accountId = c.get('accountId') as string | undefined;
  const sandboxId = c.get('sandboxId') as string | undefined;
  if (!accountId || !sandboxId) {
    return { ok: false, status: 403, error: 'sandbox token is not scoped to a session' };
  }
  if (sessionId !== null && !sandboxTokenMayActOnSession(sandboxId, sessionId)) {
    return { ok: false, status: 403, error: 'sandbox token is not scoped to this session' };
  }
  const [row] = await db
    .select({
      sessionId: sessionSandboxes.sessionId,
      baseRef: projectSessions.baseRef,
      agentName: projectSessions.agentName,
      metadata: projectSessions.metadata,
      projectId: projects.projectId,
      accountId: projects.accountId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
      projectStatus: projects.status,
    })
    .from(sessionSandboxes)
    .innerJoin(
      projectSessions,
      and(
        eq(projectSessions.accountId, sessionSandboxes.accountId),
        eq(projectSessions.projectId, sessionSandboxes.projectId),
        eq(projectSessions.sessionId, sessionSandboxes.sessionId),
      ),
    )
    .innerJoin(projects, eq(projects.projectId, sessionSandboxes.projectId))
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.accountId, accountId),
        eq(sessionSandboxes.projectId, projectId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  if (!row || (row.sessionId ?? sandboxId) !== (sessionId ?? sandboxId)) {
    return { ok: false, status: 403, error: 'sandbox token is not scoped to this project and session' };
  }
  if (row.projectStatus === 'archived') return { ok: false, status: 404, error: 'Not found' };
  return {
    ok: true,
    value: {
      sessionId: row.sessionId ?? sandboxId,
      project: row,
      session: { baseRef: row.baseRef, agentName: row.agentName, metadata: row.metadata },
    },
  };
}

/** Variant selection. Identical to `pushSessionAgentConfigToSandbox`. */
export function configReleaseVariant(session: SessionRow): ConfigReleaseVariant {
  return !repositoryAccessFromSessionMetadata(session.metadata) && session.agentName
    ? `agent:${session.agentName}`
    : 'project';
}

// POST /v1/projects/:projectId/sessions/:sessionId/config-release
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/config-release',
    tags: ['sessions'],
    summary: "A session's desired config release descriptor",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: ConfigReleaseRequestSchema } }, required: false },
    },
    responses: { 200: json(z.any(), 'Release descriptor'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(projectId) || !UUID_V4_REGEX.test(sessionId)) {
      return c.json({ error: 'Invalid project or session id' }, 400);
    }

    let project: ProjectRow;
    let session: SessionRow;
    let humanMayReadFiles = true;
    if (isSessionSandboxCredential(c)) {
      const resolved = await sandboxSession(c, projectId, sessionId);
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      ({ project, session } = resolved.value);
    } else {
      // A session-bound credential that is not a sandbox credential still acts
      // for exactly one session.
      const bound = callerKortixSessionId(c);
      if (bound && bound !== sessionId) {
        return c.json({ error: 'token is not scoped to this session' }, 403);
      }
      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_SESSION_READ,
      );
      const visible = await loadVisibleSession(loaded, sessionId, bound, bound);
      if (!visible) return c.json({ error: 'Not found' }, 404);
      project = loaded.row;
      session = visible.row;
      // The descriptor lists file paths and blob IDs. A reader without file
      // access gets governance only.
      humanMayReadFiles = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_FILE_READ,
      );
    }

    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
    }
    const parsed = ConfigReleaseRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid config release request',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
        400,
      );
    }

    const repo = gitProject(project);
    const baseRef = session.baseRef ?? project.defaultBranch;
    // The reload does the same: a push the warm mirror has not fetched must
    // not be missed.
    invalidateProjectMirror(projectId);
    let baseSha: string;
    try {
      baseSha = await resolveCommitSha(repo, baseRef);
    } catch (error) {
      return c.json({ error: `base ref ${baseRef} does not resolve: ${(error as Error).message}` }, 409);
    }

    const release = await buildConfigRelease(repo, baseSha, configReleaseVariant(session));
    const mode = await decideConfigMode({
      project: repo,
      baseSha,
      release,
      report: parsed.data.workspace ?? null,
    });
    const repositoryAccess = repositoryAccessFromSessionMetadata(session.metadata) && humanMayReadFiles;
    return c.json(toDescriptor(release, mode, { repositoryAccess }));
  },
);

// GET /v1/projects/:projectId/config-archives/:configTreeId
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/config-archives/{configTreeId}',
    tags: ['sessions'],
    summary: 'Download a config archive',
    ...auth,
    request: { params: z.object({ projectId: z.string(), configTreeId: z.string() }) },
    responses: {
      200: { description: 'The config archive', content: { 'application/gzip': { schema: z.any() } } },
      302: { description: 'Redirect to a signed store URL' },
      ...errors(400, 403, 404, 413),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const configTreeId = c.req.param('configTreeId');
    if (!UUID_V4_REGEX.test(projectId)) return c.json({ error: 'Not found' }, 404);
    if (!HEX40.test(configTreeId)) return c.json({ error: 'Not found' }, 404);

    let project: ProjectRow;
    if (isSessionSandboxCredential(c)) {
      const resolved = await sandboxSession(c, projectId, null);
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      // A session without repository access never receives a config archive.
      if (!repositoryAccessFromSessionMetadata(resolved.value.session.metadata)) {
        return c.json({ error: 'repository access withheld' }, 403);
      }
      project = resolved.value.project;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_FILE_READ,
      );
      project = loaded.row;
    }

    const repo = gitProject(project);
    return serveConfigArchive(repo, configTreeId, () => refreshMirror(repo), () => refreshMirror(repo, true));
  },
);
