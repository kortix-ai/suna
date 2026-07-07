/**
 * Meetings (Recall.ai) — voice/name settings + the public, token-gated realtime
 * relay and lifecycle webhook. Maps to spec §MEET.
 *
 * Behavior confirmed against apps/api/src/projects/routes/r4.ts + apps/api/src/channels:
 * - voices (read), voice/name (manage), preview/speak (read) are user-authed project
 *   routes via loadProjectForUser → 404/403 to non-members, 401 to anon.
 * - voice + name live in projects.metadata.meet — no Recall/ElevenLabs needed to read or
 *   set them. preview needs an ElevenLabs key (503 when absent). speak needs a live bot,
 *   so we assert only the request-validation gates (400) so the flow runs anywhere.
 * - the relay (POST /webhooks/meet/realtime) and lifecycle (POST /webhooks/meet/status)
 *   are public and verify the HMAC session token carried in bot.metadata: bad/missing → 401.
 */
import { flow } from "../core/flow";

// MEET-1 — voice catalog + current selection (read ACL).
flow(
  "MEET-1",
  { domain: "meet", routes: ["GET /v1/projects/:projectId/channels/meet/voices"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER reads voices → 200 with catalog + selected + bot_name", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/channels/meet/voices", { params: { projectId: p.id } });
      r.status(200).body().exists("$.voices").exists("$.selected").exists("$.bot_name");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/channels/meet/voices", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/channels/meet/voices", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// MEET-2 — set the bot's TTS voice (manage ACL); unknown voice → 400.
flow(
  "MEET-2",
  { domain: "meet", routes: ["PUT /v1/projects/:projectId/channels/meet/voice"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER sets a known voice → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/channels/meet/voice", { voice: "sarah" }, { params: { projectId: p.id } });
      r.status(200).body().has("$.selected", "sarah");
    });
    await ctx.step("unknown voice → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/channels/meet/voice", { voice: "not-a-voice" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER cannot set → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/channels/meet/voice", { voice: "sarah" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// MEET-3 — set the bot's display name (manage ACL); first word becomes the wake word.
flow(
  "MEET-3",
  { domain: "meet", routes: ["PUT /v1/projects/:projectId/channels/meet/name"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER sets the bot name → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/channels/meet/name", { name: "Acme Notetaker" }, { params: { projectId: p.id } });
      r.status(200).body().has("$.bot_name", "Acme Notetaker");
    });
    await ctx.step("NONMEMBER cannot set → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/channels/meet/name", { name: "X" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// MEET-4 — voice preview sample (read ACL); unknown voice → 400, no ElevenLabs key → 503.
flow(
  "MEET-4",
  { domain: "meet", routes: ["POST /v1/projects/:projectId/channels/meet/voices/:voiceId/preview"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("unknown voice → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/channels/meet/voices/:voiceId/preview", {}, {
          params: { projectId: p.id, voiceId: "not-a-voice" },
        });
      r.status(400);
    });
    await ctx.step("known voice → 200 (b64 sample) or 503 (no ElevenLabs key)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/channels/meet/voices/:voiceId/preview", {}, {
          params: { projectId: p.id, voiceId: "sarah" },
        });
      r.status([200, 503]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/channels/meet/voices/:voiceId/preview", {}, {
          params: { projectId: p.id, voiceId: "sarah" },
        });
      r.status(401);
    });
  },
);

// MEET-5 — bot speaks aloud in-call (read ACL); missing bot_id/text → 400.
flow(
  "MEET-5",
  { domain: "meet", routes: ["POST /v1/projects/:projectId/channels/meet/speak"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing bot_id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/channels/meet/speak", { text: "hello" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("missing text → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/channels/meet/speak", { bot_id: "bot_x" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/channels/meet/speak", { bot_id: "bot_x", text: "hi" }, {
          params: { projectId: p.id },
        });
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
