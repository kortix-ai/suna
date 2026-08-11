/**
 * GET /v1/public/voice-join/:token — the anonymous resolve step behind every
 * `voice_spawn` join link.
 *
 * Genuinely public: no Authorization header, no session/PAT, no Supabase
 * cookie. The whole point of a voice join link is handing it to someone
 * outside the account (see apps/web/src/middleware.ts's PUBLIC_ROUTES entry
 * for `/voice`, which this route backs) — requiring login here would defeat
 * that. The token itself, not an authenticated identity, IS the access
 * control: 256 bits of `crypto.randomBytes` (join-links.ts's `mintJoinLink`),
 * unguessable, expiring, and revoked the moment its call ends.
 *
 * Deliberately mints a FRESH LiveKit access token on every resolve rather
 * than storing one: the join link can outlive a single page load (a refresh,
 * a dropped connection, a second device), and a short-lived join link handing
 * back a token whose own TTL is independent of it — see livekit.ts's
 * `mintAccessToken`'s DEFAULT_TOKEN_TTL_SECONDS — means an open tab that sat
 * idle for a while still gets a token that works when it finally connects.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../../openapi';
import {
  createVoiceJoinLinkRateLimitMiddleware,
  createVoiceTranscriptPollRateLimitMiddleware,
} from '../../shared/rate-limit';
import { config } from '../../config';
import { mintAccessToken, roomNameForCall } from './livekit';
import { resolveJoinLink } from './join-links';
import { readTurns } from './runtime';

export const voiceJoinPublicApp = makeOpenApiApp();

voiceJoinPublicApp.use('/:token', createVoiceJoinLinkRateLimitMiddleware());
voiceJoinPublicApp.use('/:token/transcript', createVoiceTranscriptPollRateLimitMiddleware());

voiceJoinPublicApp.openapi(
  createRoute({
    method: 'get',
    path: '/{token}',
    tags: ['voice'],
    summary: 'GET /public/voice-join/:token — anonymous resolve of a voice join link',
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: json(
        z.object({ call_id: z.string(), url: z.string(), token: z.string() }),
        'LiveKit server URL + a freshly-minted access token for this call',
      ),
      ...errors(404, 410),
    },
  }),
  async (c: any) => {
    const token = c.req.param('token');
    const resolved = await resolveJoinLink(token);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

    const room = roomNameForCall(resolved.callId);
    const liveKitToken = await mintAccessToken({
      room,
      identity: `human-${resolved.callId}`,
      canPublish: true,
      canSubscribe: true,
    });

    return c.json({ call_id: resolved.callId, url: config.LIVEKIT_URL, token: liveKitToken });
  },
);

/**
 * GET /v1/public/voice-join/:token/transcript?cursor=N — the durable call
 * record for the ONE call this join link was minted for.
 *
 * Exists because LiveKit's client-side transcription is not the transcript.
 * It carries what the two voices said and nothing else, so the /voice page
 * used to show a call with holes in it: everything the Kortix agent sent into
 * the room (`send_prompt`, a finished turn's result, an error) and every MCP
 * tool call the voice made (`ask_kortix`, `run_command`) were missing —
 * they live in `kortix.voice_call_turns`, written server-side, and never
 * touch the browser's LiveKit stream at all. This is that record.
 *
 * AUTHORIZATION is the join link and only the join link — the same capability
 * the page already exchanged for its LiveKit token one route up, and the same
 * revocation (`endCall` → `revokeJoinLinksForCall` → 410). No Supabase
 * cookie, no PAT: whoever holds the link is in the call and can hear all of
 * this being said anyway.
 *
 * Deliberately NOT a workspace- or session-scoped read. `resolveJoinLink`
 * returns the call id, and that call id is the ONLY thing that reaches
 * `readTurns` — the caller never names a call, a session or a workspace, so
 * there is no id for an anonymous caller to swap for someone else's. The
 * project id the link resolves to is not echoed back either; the page has no
 * use for it and it is not this visitor's to learn.
 *
 * Cursor-paged off the same monotonic `cursor` the Kortix agent's own
 * `read_transcript` uses, so a poll that finds nothing new returns an empty
 * list and the caller's own cursor back.
 */
/** Hard ceiling on one anonymous read, and the default page size. */
const MAX_TRANSCRIPT_PAGE = 200;

/**
 * Reads `?cursor=` / `?limit=` defensively rather than validating them.
 *
 * A mangled query string on a join link (truncated in a chat client, hand-
 * edited, double-encoded) should show the call, not a 400 — the reader did
 * nothing wrong and the worst a bad cursor can mean is "start from the
 * beginning". `limit` is clamped rather than rejected for the same reason,
 * with the ceiling doing the actual work of stopping one anonymous request
 * from asking for the world.
 */
export function parseTranscriptQuery(
  rawCursor: string | undefined,
  rawLimit: string | undefined,
): { cursor: number; limit: number } {
  // Clamped at both ends. The floor makes a garbage or negative cursor mean
  // "from the beginning"; the ceiling stops an absurd one
  // (`?cursor=99999999999999999999`, which `parseInt` happily returns as 1e20)
  // from reaching Postgres as a value outside bigint and turning a bad query
  // string into a 500.
  const cursor = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Number.parseInt(rawCursor ?? '', 10) || 0),
  );
  const parsedLimit = Number.parseInt(rawLimit ?? '', 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_TRANSCRIPT_PAGE, Math.max(1, parsedLimit))
    : MAX_TRANSCRIPT_PAGE;
  return { cursor, limit };
}

voiceJoinPublicApp.openapi(
  createRoute({
    method: 'get',
    path: '/{token}/transcript',
    tags: ['voice'],
    summary: "GET /public/voice-join/:token/transcript — the call's durable transcript",
    request: {
      params: z.object({ token: z.string() }),
      query: z.object({
        cursor: z.string().optional().openapi({
          description: 'Return turns after this cursor. Omit or 0 for the whole call.',
        }),
        limit: z
          .string()
          .optional()
          .openapi({ description: 'Max turns to return (1-200, default 200).' }),
      }),
    },
    responses: {
      200: json(
        z.object({
          call_id: z.string(),
          cursor: z.number(),
          turns: z.array(
            z.object({
              cursor: z.number(),
              // user = a human in the room. agent = the agent side, which has
              // TWO sources — `speaker` tells them apart: 'kortix' is what the
              // Kortix agent put into the call, anything else is the voice's
              // own speech labelled with the bot's name. tool = an MCP call
              // the voice made; `speaker` is the tool name.
              role: z.string(),
              speaker: z.string().nullable(),
              text: z.string(),
              at: z.string(),
            }),
          ),
        }),
        'Turns after the given cursor, oldest first',
      ),
      ...errors(404, 410),
    },
  }),
  async (c: any) => {
    const token = c.req.param('token');
    const resolved = await resolveJoinLink(token);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status as any);

    const { cursor, limit } = parseTranscriptQuery(c.req.query('cursor'), c.req.query('limit'));
    const page = await readTurns(resolved.callId, cursor, limit);
    return c.json({ call_id: resolved.callId, cursor: page.cursor, turns: page.turns });
  },
);
