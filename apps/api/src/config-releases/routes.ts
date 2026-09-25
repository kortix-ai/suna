/**
 * Config release routes (docs/specs/config-releases.md, "Routes").
 *
 * POST /v1/projects/:projectId/sessions/:sessionId/config-release
 *   The desired release descriptor for one session: always the base branch's
 *   current tip. The request carries no inputs. Callers: the session's own
 *   sandbox token, or a project member who can read that session.
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
import { refreshMirror } from '../projects/git/mirror';
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
import { isUuid } from '../shared/validate';
import { db } from '../shared/db';
import { requireFeatureFlag } from '../feature-flags/gate';
import { CONFIG_RELEASES_FLAG } from './enabled';
import { BaseRefUnresolvedError, resolveDesiredRelease } from './desired';
import { ownerMayUseAgent, repointSessionAgentToDeclaredDefault } from './repoint';
import { serveConfigArchive } from './serve-archive';

const HEX40 = /^[0-9a-f]{40}$/;

interface ProjectRow {
  projectId: string;
  accountId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string | null;
  metadata: unknown;
}

/**
 * CHOKEPOINT — the `config_releases` flag for both routes of this file
 * (docs/specs/config-releases.md, "Feature flag"). Off ⇒ `403`
 * `feature_disabled`, so no release is built, no archive is stored, and no
 * `kortix.config_releases` row is written. Always AFTER authz, so a
 * non-member learns nothing from the answer. The daemon reads this exact
 * `code` and reverts to its workspace config dir
 * (`isFeatureDisabledError`, harness/open-code/config-release.ts).
 */
function configReleasesGate(c: Context, project: ProjectRow): Response | null {
  return requireFeatureFlag(c, project.metadata, CONFIG_RELEASES_FLAG);
}

interface SessionRow {
  baseRef: string | null;
  agentName: string | null;
  metadata: unknown;
  /** `project_sessions.created_by` — whose access an agent re-point clears. */
  createdBy: string | null;
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
      createdBy: projectSessions.createdBy,
      projectId: projects.projectId,
      accountId: projects.accountId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
      projectMetadata: projects.metadata,
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
      project: { ...row, metadata: row.projectMetadata },
      session: {
        baseRef: row.baseRef,
        agentName: row.agentName,
        metadata: row.metadata,
        createdBy: row.createdBy,
      },
    },
  };
}


// POST /v1/projects/:projectId/sessions/:sessionId/config-release
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/config-release',
    tags: ['sessions'],
    summary: "A session's desired config release descriptor",
    ...auth,
    request: { params: z.object({ projectId: z.string(), sessionId: z.string() }) },
    responses: { 200: json(z.any(), 'Release descriptor'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(projectId) || !isUuid(sessionId)) {
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

    const disabled = configReleasesGate(c, project);
    if (disabled) return disabled;

    // The request has no inputs. The desired release is the base branch's
    // current tip for this session's variant, full stop: nothing the caller
    // sends can change which config it is assigned. Any body is ignored, so a
    // daemon built against an older shape of this route still converges.
    //
    // EVERY session of this project is served, including one created before
    // the project replaced its repository. A release is the project's CURRENT
    // config; the session's own `/workspace` clone is untouched by it and
    // stays on the repository it was cloned from. Nothing else refuses such a
    // session either — `sameRepository` (projects/lib/git.ts) compares the
    // project row against ITSELF across an authorization, to bust the 30 s
    // memo when a replacement lands mid-request. What is left is physical:
    // that clone and the new origin hold unrelated histories, so Git itself
    // refuses a push without a rebase.
    const baseRef = session.baseRef ?? project.defaultBranch;
    try {
      // THE ONE WRITER of `project_sessions.agent_name` after create
      // (config-releases/repoint.ts). Only the daemon's own request persists:
      // a human read decides and reports the same answer without writing, so
      // `GET /config` and the descriptor never disagree about `stale`.
      const subject = {
        projectId,
        accountId: project.accountId,
        sessionId,
        ownerUserId: session.createdBy,
      };
      const isDaemon = isSessionSandboxCredential(c);
      const desired = await resolveDesiredRelease({
        project: gitProject(project),
        baseRef,
        sessionAgent: session.agentName,
        repositoryAccess: repositoryAccessFromSessionMetadata(session.metadata) && humanMayReadFiles,
        // Only the daemon's own request is an assignment. A human read is not.
        recordAssignment: isDaemon,
        ownerMayUseAgent: (agent) => ownerMayUseAgent(subject, agent),
        ...(isDaemon
          ? { persistRepoint: (from: string, to: string) => repointSessionAgentToDeclaredDefault(subject, from, to) }
          : {}),
      });
      return c.json(desired.descriptor);
    } catch (error) {
      if (error instanceof BaseRefUnresolvedError) return c.json({ error: error.message }, 409);
      throw error;
    }
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
    request: {
      params: z.object({ projectId: z.string(), configTreeId: z.string() }),
      // Set on a composed release tree (config dir plus root skills): the
      // commit it is rebuilt from when the store cannot serve it.
      query: z.object({ commit: z.string().optional() }),
    },
    responses: {
      200: { description: 'The config archive', content: { 'application/gzip': { schema: z.any() } } },
      302: { description: 'Redirect to a signed store URL' },
      ...errors(400, 403, 404, 409, 413),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const configTreeId = c.req.param('configTreeId');
    if (!isUuid(projectId)) return c.json({ error: 'Not found' }, 404);
    if (!HEX40.test(configTreeId)) return c.json({ error: 'Not found' }, 404);

    let project: ProjectRow;
    if (isSessionSandboxCredential(c)) {
      const resolved = await sandboxSession(c, projectId, null);
      if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
      // A session without repository access never receives a config archive.
      // A previous-repository session DOES: the archive is the project's
      // config dir, which is what every session of the project runs.
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

    const disabled = configReleasesGate(c, project);
    if (disabled) return disabled;

    const repo = gitProject(project);
    return serveConfigArchive(
      repo,
      configTreeId,
      () => refreshMirror(repo),
      () => refreshMirror(repo, true),
      {},
      c.req.query('commit') ?? null,
    );
  },
);
