/**
 * Session transcript reads: the compact server-side chat transcript and the
 * live voice-call transcript. Both are project-read + session-visible gated.
 */

import { isCallLive, readTurns } from '../../channels/voice/runtime';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { and } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { callerKortixSessionId } from '../lib/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX,
  parseBoundedPositiveInt,
} from '../lib/serializers';
import { buildSessionTranscriptDigest } from '../lib/session-transcript';

// GET /v1/projects/:projectId/sessions/:sessionId/transcript
// Compact server-side transcript read for project automation. Unlike the raw
// /v1/p sandbox proxy, this endpoint is callable with project-scoped session
// tokens and strips tool inputs/outputs before returning messages.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/transcript',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/transcript',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        query: z.object({
          limit: z.string().optional(),
          chars: z.string().optional(),
        }),
      },
    responses: {
        200: json(AnyObject, 'Compact session transcript'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sessionId = c.req.param('sessionId');
  if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

  const limit = parseBoundedPositiveInt(c.req.query('limit'), 40, 1, 500, 'limit');
  if (!limit.ok) return c.json({ error: limit.error }, 400);
  const maxChars = parseBoundedPositiveInt(c.req.query('chars'), 700, 80, 5000, 'chars');
  if (!maxChars.ok) return c.json({ error: maxChars.error }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );

  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  if (!visible) return c.json({ error: 'Not found' }, 404);

  const transcript = await buildSessionTranscriptDigest({
    session: visible.row,
    projectId,
    accountId: loaded.row.accountId,
    userId: loaded.userId,
    limit: limit.value,
    maxChars: maxChars.value,
  });
  return c.json(transcript);
},
);

// GET /v1/projects/:projectId/sessions/:sessionId/voice-transcript
// The live-call transcript for a session's voice connector call — every spoken
// turn (role 'user'/'agent', from voice_call_turns) PLUS every ask_kortix/
// run_command the worker issued through the voice MCP (role 'tool', recorded
// by mcp.ts's callTool). A session's callId IS its sessionId (see
// channels/voice/runtime.ts's file header), so there is nothing to look up
// beyond the session itself.
//
// `role` alone does not identify a turn — read `speaker` with it:
//   user  + <null>          a human in the room
//   agent + 'kortix'        what the Kortix agent put into the call
//                           (channels/voice/utterance.ts's KORTIX_SPEAKER,
//                           written server-side the moment it is delivered)
//   agent + <bot name>      what the voice actually said, as the worker heard
//                           itself say it (apps/voice-agent/src/transcripts.ts)
//   tool  + <tool name>     an ask_kortix/run_command the worker issued; the
//                           text carries the argument and the outcome
// The two `agent` rows are not duplicates: one is the instruction Kortix sent,
// the other the model's spoken phrasing of it, and either can appear alone.
//
// This is a THIN read wrapper around `readTurns`/`isCallLive` (already used
// internally by the voice runtime) for the one thing they didn't have yet: a
// route a Kortix-authenticated browser session can call. Same visibility gate
// as /transcript and /audit above — project read + the session must be
// visible to the caller — deliberately NOT the worker's per-call HMAC auth
// (routes.ts), which authorizes exactly one call and would be the wrong tool
// for "a person looking at the session in the web app".
//
// `cursor` makes this a plain incremental poll: pass back the `cursor` this
// endpoint returned last time and only new turns come back, in order — the
// same non-blocking "what's new since X" contract `readTurns` already gives
// the voice agent loop.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/voice-transcript',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/voice-transcript',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, "A session's live voice-call transcript"),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const cursor = parseBoundedPositiveInt(
      c.req.query('cursor'),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      'cursor',
    );
    if (!cursor.ok) return c.json({ error: cursor.error }, 400);
    const limit = parseBoundedPositiveInt(c.req.query('limit'), 200, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const [page, live] = await Promise.all([
      readTurns(sessionId, cursor.value, limit.value),
      isCallLive(sessionId),
    ]);

    return c.json({
      session_id: sessionId,
      call_id: sessionId,
      live,
      cursor: page.cursor,
      count: page.turns.length,
      turns: page.turns,
    });
  },
);
