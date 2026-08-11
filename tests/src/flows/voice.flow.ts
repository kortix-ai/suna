/**
 * Voice (live calls) — the bot-name setting, the worker MCP's auth boundary,
 * the session-scoped transcript read, and the two public join-link routes.
 * Maps to spec §VOICE.
 *
 * TWO surfaces exist and they point in OPPOSITE directions — the flows below
 * only touch the second, because the first is not an HTTP route at all:
 *
 *  - The Kortix agent's side is the `kortix_voice` CONNECTOR (spawn_room /
 *    read_transcript / send_prompt / end_call, plus the declared-but-
 *    unimplemented join_gmeet / join_zoom) — connector/channels.ts. It runs
 *    through the connector gateway like every other connector, so it has no
 *    route of its own to cover. It used to be an MCP at
 *    `POST /projects/:id/mcp/voice`; that route is GONE.
 *  - The LiveKit worker's side is the voice MCP,
 *    `POST /projects/:id/sessions/:sid/mcp/voice` — channels/voice/routes.ts,
 *    serving ask_kortix / run_command / post_turn.
 *
 * What is asserted here is deliberately the shape of the contract, not a live
 * call: spawning one costs realtime-provider minutes and needs a live worker
 * to talk back. The behaviours that actually break things — a Kortix
 * principal being able to drive the worker MCP, an anonymous join link
 * honouring a session or project id, a transcript read that skips its project
 * gate — are all checkable without one.
 */
import { flow } from '../core/flow';

/** A UUID the API will never have issued. The worker MCP looks nothing up, so
 *  this is enough to address it; the transcript read 404s on it by design. */
const ABSENT_UUID = '00000000-0000-4000-a000-0000000000ff';

/** Shaped like a real join token (`vjl_` + 32 random bytes, base64url) and
 *  guaranteed never to have been minted. */
const ABSENT_JOIN_TOKEN = `vjl_${'A'.repeat(43)}`;

// VOICE-1 — the bot's display name in the call (manage ACL).
flow(
  'VOICE-1',
  { domain: 'voice', routes: ['PUT /v1/projects/:workspaceId/channels/meet/name'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step('OWNER sets the name → 200', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put('/v1/projects/:workspaceId/channels/meet/name', { name: 'Kortix QA' }, {
          params: { workspaceId: p.id },
        });
      r.status(200).body().exists('$.bot_name');
    });
    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put('/v1/projects/:workspaceId/channels/meet/name', { name: 'nope' }, {
          params: { workspaceId: p.id },
        });
      r.status([403, 404]);
    });
    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put('/v1/projects/:workspaceId/channels/meet/name', { name: 'nope' }, {
          params: { workspaceId: p.id },
        });
      r.status(401);
    });
  },
);

// VOICE-2 — the worker MCP's auth boundary.
//
// This route is authed ONLY by the per-call `kortix_api_token`: an HMAC over
// the call id, minted server-side in startCall and handed to the LiveKit
// worker in the room metadata (channels/voice/worker-token.ts). No black-box
// client can hold one, so the TOOL half (ask_kortix / run_command /
// post_turn) is not reachable from out here — but the boundary is the part
// worth asserting and it IS fully reachable: nothing a normal Kortix caller
// can present may open this door.
//
// It matters because the route is mounted BEFORE projectsApp specifically so
// it skips `supabaseAuth`. If that ordering is ever undone, or a `.use()` is
// layered back onto this path, a project principal starts being accepted
// here — and this flow goes red.
flow(
  'VOICE-2',
  { domain: 'voice', routes: ['POST /v1/projects/:workspaceId/sessions/:sessionId/mcp/voice'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { workspaceId: p.id, sessionId: ABSENT_UUID };
    const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/:workspaceId/sessions/:sessionId/mcp/voice', listTools, { params });
      r.status(401);
    });

    await ctx.step('OWNER session is not a worker token → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/projects/:workspaceId/sessions/:sessionId/mcp/voice', listTools, { params });
      r.status(401);
    });

    await ctx.step('account PAT is not a worker token → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.PAT_ACCT)
        .post('/v1/projects/:workspaceId/sessions/:sessionId/mcp/voice', listTools, { params });
      r.status(401);
    });

    await ctx.step('forged bearer of the right shape → 401', async () => {
      // 64 hex chars — exactly what a real sha256 HMAC looks like. The check is
      // length-guarded and timing-safe, so this proves the HMAC itself does the
      // rejecting rather than some shape heuristic upstream of it.
      const r = await ctx.client
        .withBearer('0'.repeat(64), 'FORGED_WORKER_TOKEN')
        .post('/v1/projects/:workspaceId/sessions/:sessionId/mcp/voice', listTools, { params });
      r.status(401);
    });

    await ctx.step('auth precedes the body → malformed JSON is still 401', async () => {
      // Never 400 and never 500: an unauthenticated caller must not reach the
      // parser, nor be able to tell a parse error from a rejected token.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post('/v1/projects/:workspaceId/sessions/:sessionId/mcp/voice', '{not json', {
          params,
          raw: true,
        });
      r.status(401);
    });
  },
);

// VOICE-3 — the session-scoped transcript read, boundary half.
//
// Cheap on purpose (no sandbox): this is the auth + validation contract, which
// is the half that regresses. VOICE-4 asserts the 200 shape on a real session.
flow(
  'VOICE-3',
  { domain: 'voice', routes: ['GET /v1/projects/:workspaceId/sessions/:sessionId/voice-transcript'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    await ctx.step('non-uuid session id → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: 'not-a-uuid' },
        });
      r.status(400);
    });

    await ctx.step('unparseable cursor → 400', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: ABSENT_UUID },
          query: { cursor: 'nope' },
        });
      r.status(400);
    });

    await ctx.step('unknown session → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: ABSENT_UUID },
        });
      r.status(404);
    });

    await ctx.step('NONMEMBER → 403/404', async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: ABSENT_UUID },
        });
      r.status([403, 404]);
    });

    await ctx.step('ANON → 401', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: ABSENT_UUID },
        });
      r.status(401);
    });
  },
);

// VOICE-4 — the transcript read on a real session that has never had a call:
// the empty-but-well-formed answer the web app polls. `live:false` plus an
// empty page is the contract, not a 404 — a session without a call is a
// session with a zero-length transcript, and the page must render it.
flow(
  'VOICE-4',
  {
    domain: 'voice',
    requires: ['daytona', 'funded'],
    timeoutMs: 300_000,
    routes: ['GET /v1/projects/:workspaceId/sessions/:sessionId/voice-transcript'],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedSeededProject();
    const s = await ctx.fixtures.session(p);
    await ctx.step('session with no call → 200, empty, not live', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/projects/:workspaceId/sessions/:sessionId/voice-transcript', {
          params: { workspaceId: p.id, sessionId: s.id },
        });
      r.status(200)
        .body()
        // The call id IS the session id — the browser needs no second lookup.
        .has('$.session_id', s.id)
        .has('$.call_id', s.id)
        .has('$.live', false)
        .has('$.count', 0);
    });
  },
);

// VOICE-5 — the public join-link resolve.
//
// Unauthenticated by design: a join link is a capability handed to someone
// outside the account, so requiring login would defeat it. The assertions that
// matter are therefore about what it REFUSES — an unknown token is 404, and
// nothing id-shaped is honoured, because a project or session id resolving to
// a call would put every call in the account one guess away. 410
// (ended/revoked/expired) needs a real call to end, so it is proven against
// the real route + DB in apps/api's integration-voice-join-links.test.ts.
flow(
  'VOICE-5',
  { domain: 'voice', routes: ['GET /v1/public/voice-join/:token'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    await ctx.step('unknown vjl_ token → 404, not 401 (the route is public)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token', { params: { token: ABSENT_JOIN_TOKEN } });
      r.status(404);
    });

    await ctx.step('a project id is not a join token → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token', { params: { token: p.id } });
      r.status(404);
    });

    await ctx.step('a bare uuid is not a join token → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token', { params: { token: ABSENT_UUID } });
      r.status(404);
    });
  },
);

// VOICE-6 — the public transcript behind the same join link.
//
// The one route where an id-shaped input would be a real leak: it returns what
// was said in a call, and it takes NO project or session id —
// `resolveJoinLink` hands `readTurns` the call id and nothing the caller wrote
// ever reaches it. These steps assert that from the outside: no id, and no
// query parameter, gets a call out of it.
flow(
  'VOICE-6',
  { domain: 'voice', routes: ['GET /v1/public/voice-join/:token/transcript'] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    await ctx.step('unknown vjl_ token → 404, not 401 (the route is public)', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token/transcript', { params: { token: ABSENT_JOIN_TOKEN } });
      r.status(404);
    });

    await ctx.step('a project id is not a join token → 404', async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token/transcript', { params: { token: p.id } });
      r.status(404);
    });

    await ctx.step('no id-shaped query parameter is honoured → still 404', async () => {
      // If any of these were read, an unknown token plus a known project or
      // session id would hand back somebody else's call.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token/transcript', {
          params: { token: ABSENT_UUID },
          query: { call_id: ABSENT_UUID, session_id: ABSENT_UUID, project_id: p.id },
        });
      r.status(404);
    });

    await ctx.step('a mangled cursor is not a 400 — the reader did nothing wrong', async () => {
      // parseTranscriptQuery clamps rather than rejects, so a link truncated in
      // a chat client still resolves (to 404 here, the token being unknown)
      // instead of turning a bad query string into a validation error.
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get('/v1/public/voice-join/:token/transcript', {
          params: { token: ABSENT_JOIN_TOKEN },
          query: { cursor: '99999999999999999999', limit: '-1' },
        });
      r.status(404);
    });
  },
);
