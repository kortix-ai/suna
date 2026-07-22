/**
 * Meetings (Recall.ai) — voice/name settings + the public, token-gated realtime
 * relay and lifecycle webhook. Maps to spec §MEET.
 *
 * Behavior confirmed against apps/api/src/projects/routes/connectors-channels.ts +
 * apps/api/src/channels/registry/meet.ts:
 * - voices (read), voice/name (manage), preview/speak (read) are user-authed project
 *   routes via loadProjectForUser → 404/403 to non-members, 401 to anon. They are
 *   dispatched through the generic connector-channel actions surface:
 *   /v1/projects/:projectId/connectors/channels/meet/actions/{voices,setName,setVoice,
 *   previewVoice,speak}. previewVoice's voiceId moves from a path segment into the
 *   JSON body ({ voiceId }) — the generic dispatch route has no room for a nested
 *   path segment.
 * - voice + name live in projects.metadata.meet — no Recall/ElevenLabs needed to read or
 *   set them. preview needs an ElevenLabs key (503 when absent). speak needs a live bot,
 *   so we assert only the request-validation gates (400) so the flow runs anywhere.
 * - the relay (POST /webhooks/meet/realtime) and lifecycle (POST /webhooks/meet/status)
 *   are public and verify the HMAC session token carried in bot.metadata: bad/missing → 401.
 */
import { flow } from "../core/flow";

const ACTIONS = "/v1/projects/:projectId/connectors/channels/:platform/actions/:action";

// MEET-1 — voice catalog + current selection (read ACL).
flow(
  "MEET-1",
  { domain: "meet", routes: ["GET /v1/projects/:projectId/connectors/channels/:platform/actions/:action"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { projectId: p.id, platform: "meet", action: "voices" };
    await ctx.step("OWNER reads voices → 200 with catalog + selected + bot_name", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get(ACTIONS, { params });
      r.status(200).body().exists("$.voices").exists("$.selected").exists("$.bot_name");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).get(ACTIONS, { params });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get(ACTIONS, { params });
      r.status(401);
    });
  },
);

// MEET-2 — set the bot's TTS voice (manage ACL); unknown voice → 400.
flow(
  "MEET-2",
  { domain: "meet", routes: ["PUT /v1/projects/:projectId/connectors/channels/:platform/actions/:action"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { projectId: p.id, platform: "meet", action: "setVoice" };
    await ctx.step("OWNER sets a known voice → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(ACTIONS, { voice: "sarah" }, { params });
      r.status(200).body().has("$.selected", "sarah");
    });
    await ctx.step("unknown voice → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(ACTIONS, { voice: "not-a-voice" }, { params });
      r.status(400);
    });
    await ctx.step("NONMEMBER cannot set → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).put(ACTIONS, { voice: "sarah" }, { params });
      r.status([403, 404]);
    });
  },
);

// MEET-3 — set the bot's display name (manage ACL); first word becomes the wake word.
flow(
  "MEET-3",
  { domain: "meet", routes: ["PUT /v1/projects/:projectId/connectors/channels/:platform/actions/:action"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { projectId: p.id, platform: "meet", action: "setName" };
    await ctx.step("OWNER sets the bot name → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put(ACTIONS, { name: "Acme Notetaker" }, { params });
      r.status(200).body().has("$.bot_name", "Acme Notetaker");
    });
    await ctx.step("NONMEMBER cannot set → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).put(ACTIONS, { name: "X" }, { params });
      r.status([403, 404]);
    });
  },
);

// MEET-4 — voice preview sample (read ACL); unknown voice → 400, no ElevenLabs key → 503.
// Contract change: voiceId now travels in the JSON body ({ voiceId }), not a path segment.
flow(
  "MEET-4",
  { domain: "meet", routes: ["POST /v1/projects/:projectId/connectors/channels/:platform/actions/:action"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { projectId: p.id, platform: "meet", action: "previewVoice" };
    await ctx.step("unknown voice → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(ACTIONS, { voiceId: "not-a-voice" }, { params });
      r.status(400);
    });
    await ctx.step("known voice → 200 (b64 sample) or 503 (no ElevenLabs key)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(ACTIONS, { voiceId: "sarah" }, { params });
      r.status([200, 503]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post(ACTIONS, { voiceId: "sarah" }, { params });
      r.status(401);
    });
  },
);

// MEET-5 — bot speaks aloud in-call (read ACL); missing bot_id/text → 400.
flow(
  "MEET-5",
  { domain: "meet", routes: ["POST /v1/projects/:projectId/connectors/channels/:platform/actions/:action"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const params = { projectId: p.id, platform: "meet", action: "speak" };
    await ctx.step("missing bot_id → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(ACTIONS, { text: "hello" }, { params });
      r.status(400);
    });
    await ctx.step("missing text → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(ACTIONS, { bot_id: "bot_x" }, { params });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(ACTIONS, { bot_id: "bot_x", text: "hi" }, { params });
      r.status([403, 404]);
    });
  },
);

// MEET-6 — Recall realtime relay (public, HMAC token in bot.metadata).
flow(
  "MEET-6",
  { domain: "meet", routes: ["POST /v1/webhooks/meet/realtime"] },
  async (ctx) => {
    await ctx.step("missing/invalid session token → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/webhooks/meet/realtime", {
        event: "transcript.data",
        data: { bot: { id: "bot_x", metadata: { kortix_session_id: "sess_x", kortix_token: "bad" } } },
      });
      r.status(401);
    });
  },
);

// MEET-7 — Recall lifecycle (public); on bot.done (token-verified) auto-recaps the session.
flow(
  "MEET-7",
  { domain: "meet", routes: ["POST /v1/webhooks/meet/status"] },
  async (ctx) => {
    await ctx.step("missing/invalid session token → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/webhooks/meet/status", {
        event: "bot.done",
        data: { bot: { id: "bot_x", metadata: { kortix_session_id: "sess_x", kortix_token: "bad" } } },
      });
      r.status(401);
    });
  },
);
