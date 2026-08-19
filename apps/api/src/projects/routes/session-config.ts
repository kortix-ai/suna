/**
 * Agent-config freshness for a running session: is the box spawned from the
 * latest compiled manifest, and the reload that brings it up to date (JSON for
 * the CLI, streamed phases for the web).
 */

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { and, or } from 'drizzle-orm';
import { config } from '../../config';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, readBody } from '../lib/serializers';
import { callerKortixSessionId } from '../lib/caller-session';
import { assertAgentScope } from '../../iam/agent-scope';
import { mayChangeSessionModel } from '../lib/session-model-change';
import { isConfigStale, latestAgentConfigEtag, readSandboxConfigState, reloadDetail, reloadSessionConfig } from '../lib/session-reload';
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/config',
    tags: ['sessions'],
    summary: "Whether a session's agent config is the latest",
    ...auth,
    request: { params: z.object({ projectId: z.string(), sessionId: z.string() }) },
    responses: { 200: json(z.any(), 'Config freshness'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // `loadProjectForUser(..., 'session')` is the coarse access level, not a
    // read grant. Without this an agent-scoped or read-restricted token could
    // read a session's commit sha and config hash — small, but it is session
    // state, and every other session READ on this router asserts the same leaf.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const baseRef = visible.row.baseRef ?? loaded.row.defaultBranch;
    const [running, latest] = await Promise.all([
      readSandboxConfigState({ sessionId }),
      latestAgentConfigEtag({
        projectId,
        accountId: loaded.row.accountId,
        sessionId,
        baseRef,
      }),
    ]);
    return c.json({
      base_ref: baseRef,
      running_etag: running.etag,
      latest_etag: latest,
      commit_sha: running.commitSha,
      // `null` when it cannot be told — an unreachable box or a project with no
      // compiled config. Never `false`, which would read as "up to date" when
      // the truth is "did not ask".
      stale: isConfigStale(running.etag, latest),
      sandbox_reachable: running.reachable,
    });
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/reload
// Pull the workspace and recompile the agent config into a RUNNING session.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/reload',
    tags: ['sessions'],
    summary: "Reload a running session's agent config from git",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: false },
    },
    responses: { 200: json(z.any(), 'Reload result'), ...errors(400, 403, 404, 409) },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Same gate as re-scoping and changing the model: seeing a session is not
    // permission to restart the runtime underneath someone else's work.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can reload this session' },
        403,
      );
    }

    const body = (await readBody(c)) as { refresh_repo?: unknown; force?: unknown };

    const result = await reloadSessionConfig({
      projectId,
      accountId: loaded.row.accountId,
      sessionId,
      repoUrl: loaded.row.repoUrl,
      defaultBranch: loaded.row.defaultBranch,
      manifestPath: loaded.row.manifestPath,
      baseRef: visible.row.baseRef ?? loaded.row.defaultBranch,
      refreshRepo: body?.refresh_repo !== false,
      force: body?.force === true,
    });
    // A reload restarts opencode, which ENDS the turn in flight. Refused by
    // default rather than discarding someone's work without saying so.
    if (
      result.reason === 'session is mid-turn' ||
      result.reason === 'could not confirm the session is idle'
    ) {
      return c.json(
        {
          ...result,
          error:
            result.reason === 'session is mid-turn'
              ? 'This session is mid-turn. A reload restarts the runtime and ends it — retry when idle, or pass force: true.'
              : 'Could not confirm this session is idle, and a reload restarts the runtime. Retry, or pass force: true.',
          code: 'SESSION_BUSY',
        },
        409,
      );
    }
    return c.json({
      ...result,
      detail: reloadDetail(result),
    });
  },
);

// POST /v1/projects/:projectId/sessions/:sessionId/reload-stream
// Same reload as POST /reload. This sibling route preserves the JSON contract
// used by the CLI while letting web clients render real operation phases.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/reload-stream',
    tags: ['sessions'],
    summary: "Reload a running session's agent config with live progress",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: false },
    },
    responses: {
      200: {
        description: 'A text/event-stream ending in one done or error frame',
        content: { 'text/event-stream': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can reload this session' },
        403,
      );
    }

    const body = (await readBody(c)) as { refresh_repo?: unknown; force?: unknown };

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let readable = true;
          const write = (data: unknown) => {
            if (!readable) return;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              readable = false;
            }
          };

          try {
            const result = await reloadSessionConfig({
              projectId,
              accountId: loaded.row.accountId,
              sessionId,
              repoUrl: loaded.row.repoUrl,
              defaultBranch: loaded.row.defaultBranch,
              manifestPath: loaded.row.manifestPath,
              baseRef: visible.row.baseRef ?? loaded.row.defaultBranch,
              refreshRepo: body?.refresh_repo !== false,
              force: body?.force === true,
              onPhase: (phase) => write({ type: 'phase', phase }),
            });

            if (
              result.reason === 'session is mid-turn' ||
              result.reason === 'could not confirm the session is idle'
            ) {
              write({
                type: 'error',
                error:
                  result.reason === 'session is mid-turn'
                    ? 'This session is mid-turn. A reload restarts the runtime and ends it — retry when idle, or pass force: true.'
                    : 'Could not confirm this session is idle, and a reload restarts the runtime. Retry, or pass force: true.',
                code: 'SESSION_BUSY',
                status: 409,
                reason: result.reason,
              });
            } else {
              write({ type: 'done', result: { ...result, detail: reloadDetail(result) } });
            }
          } catch (error) {
            write({
              type: 'error',
              error: error instanceof Error && error.message ? error.message : 'Reload failed',
            });
          } finally {
            if (readable) {
              try {
                controller.close();
              } catch {}
            }
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      },
    ) as any;
  },
);
