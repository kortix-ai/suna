/**
 * Session environment routes (harness/worker split P1.7 — lazy compute).
 *
 * The pi worker calls `ensure` on its FIRST compute tool call, with its own
 * session credential; humans and the dashboard may call it too. The response
 * hands back a provider-edge origin (preview URL + token) — worker↔environment
 * traffic runs over the edge, never through the session proxy.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import {
  ensureSessionEnvironment,
  readSessionEnvironment,
  SessionEnvironmentError,
  stopSessionEnvironment,
} from '../../platform/services/session-environment';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { UUID_V4_REGEX } from '../lib/serializers';
import { guardSession, sessionAccessDenied, type SessionNeed } from '../lib/session-access';

const EnvironmentSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  external_id: z.string().nullable(),
  preview_url: z.string().nullable(),
  preview_token: z.string().nullable(),
});

interface SessionForEnvironment {
  agentName: string;
  baseRef: string;
  metadata: Record<string, unknown>;
}

/**
 * Shared gate: the project loads for the caller, and the session resolves
 * through the shared session guard — scoped to THIS project and account,
 * visible to the caller, not deleted. `read` needs only visibility; `ensure`
 * and `stop` spend or stop compute, so they need lifecycle authority (owner or
 * project manager). A session-scoped caller (the worker's KORTIX_TOKEN) may
 * only address its OWN environment — a compromised worker cannot enumerate or
 * boot siblings. Returns the pieces every handler needs or a Response to send
 * as-is.
 */
async function authorizeEnvironmentCall(
  c: Parameters<Parameters<typeof projectsApp.openapi>[1]>[0],
  action: (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS],
  need: SessionNeed,
): Promise<
  | { kind: 'error'; response: Response }
  | {
      kind: 'ok';
      projectId: string;
      sessionId: string;
      userId: string;
      accountId: string;
      row: Awaited<ReturnType<typeof loadProjectForUser>> extends infer L
        ? L extends { row: infer R }
          ? R
          : never
        : never;
      session: SessionForEnvironment;
    }
> {
  const projectId = c.req.param('projectId') ?? '';
  const sessionId = c.req.param('sessionId') ?? '';
  if (!UUID_V4_REGEX.test(sessionId)) {
    return { kind: 'error', response: c.json({ error: 'Invalid session id' }, 400) };
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { kind: 'error', response: c.json({ error: 'Not found' }, 404) };
  const callerSession = callerKortixSessionId(c);
  if (callerSession && callerSession !== sessionId) {
    return { kind: 'error', response: c.json({ error: 'Forbidden' }, 403) };
  }
  if (!callerSession) {
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
  }
  const guard = await guardSession(c, loaded, sessionId, need);
  if (!guard.ok) return { kind: 'error', response: sessionAccessDenied(c, guard) };
  const session = guard.session.row;
  return {
    kind: 'ok',
    projectId,
    sessionId,
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    row: loaded.row as never,
    session: {
      agentName: session.agentName ?? 'default',
      baseRef: session.baseRef ?? '',
      metadata: (session.metadata as Record<string, unknown> | null) ?? {},
    },
  };
}

function serialize(info: {
  sessionId: string;
  status: string;
  externalId: string | null;
  previewUrl: string | null;
  previewToken: string | null;
}) {
  return {
    session_id: info.sessionId,
    status: info.status,
    external_id: info.externalId,
    preview_url: info.previewUrl,
    preview_token: info.previewToken,
  };
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/environment/ensure',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/environment/ensure',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(EnvironmentSchema, 'The session environment, provisioned or resumed'),
      ...errors(400, 403, 404, 409, 502, 504),
    },
  }),
  async (c) => {
    const gate = await authorizeEnvironmentCall(c, PROJECT_ACTIONS.PROJECT_SESSION_START, 'lifecycle');
    if (gate.kind === 'error') return gate.response as never;
    // Environments exist for worker sessions only: an OpenCode session's own
    // sandbox IS its environment, and ensuring a second box for it would just
    // double compute.
    if (gate.session.metadata.sandbox_slug !== 'pi-worker') {
      return c.json({ error: 'Session does not run on the pi worker' }, 400);
    }
    const project = gate.row as {
      repoUrl: string;
      defaultBranch: string;
      manifestPath: string | null;
    };
    try {
      const info = await ensureSessionEnvironment({
        sessionId: gate.sessionId,
        projectId: gate.projectId,
        accountId: gate.accountId,
        userId: gate.userId,
        agentName: gate.session.agentName,
        baseRef: gate.session.baseRef || project.defaultBranch,
        gitProject: {
          projectId: gate.projectId,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          manifestPath: project.manifestPath ?? 'kortix.yaml',
          gitAuthToken: null,
        },
      });
      return c.json(serialize(info));
    } catch (err) {
      if (err instanceof SessionEnvironmentError) {
        return c.json({ error: err.message }, err.status as never);
      }
      throw err;
    }
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/environment',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/environment',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(EnvironmentSchema, 'Environment status (never provisions)'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const gate = await authorizeEnvironmentCall(c, PROJECT_ACTIONS.PROJECT_SESSION_READ, 'read');
    if (gate.kind === 'error') return gate.response as never;
    const info = await readSessionEnvironment(gate.sessionId);
    if (!info) return c.json({ error: 'No environment' }, 404);
    return c.json(serialize(info));
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/environment/stop',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/environment/stop',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(EnvironmentSchema, 'The stopped environment'),
      ...errors(400, 403, 404),
    },
  }),
  async (c) => {
    const gate = await authorizeEnvironmentCall(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP, 'lifecycle');
    if (gate.kind === 'error') return gate.response as never;
    const info = await stopSessionEnvironment(gate.sessionId);
    if (!info) return c.json({ error: 'No environment' }, 404);
    return c.json(serialize(info));
  },
);
