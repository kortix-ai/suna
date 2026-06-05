/**
 * Persistent message queue — black-box HTTP. Maps to spec §queue (Q-*).
 *
 * Mounted at /v1/queue/* behind `combinedAuth` (OWNER JWT accepted, ANON → 401).
 * The queue is in-memory keyed by an opaque sessionId/messageId string — the
 * routes never validate that the session/message exists in the DB, so for
 * unknown ids the handlers return their own shapes:
 *   - GET    /sessions/:id        → 200 { messages: [] }      (empty list, not 404)
 *   - GET    /all                 → 200 { messages: [...] }
 *   - GET    /status              → 200 { drainerRunning }
 *   - POST   /sessions/:id        → 201 { message } | 400 (missing text)
 *   - DELETE /messages/:id        → 404 (not found) | 200 { ok }
 *   - DELETE /sessions/:id        → 200 { ok } (idempotent clear)
 *   - POST   /messages/:id/move-* → 400 (missing sessionId / not found) | 200
 */
import { flow } from "../core/flow";

const uuid = () => crypto.randomUUID();

// ─── Q-2: read endpoints (all / status) ──────────────────────────────────────

flow("Q-2", { domain: "queue", tags: ["smoke"], routes: ["GET /v1/queue/all", "GET /v1/queue/status"] }, async (ctx) => {
  await ctx.step("GET /queue/all → 200 list", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/queue/all");
    r.status(200).body().exists("$.messages");
  });
  await ctx.step("GET /queue/status → 200 with drainer flag", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/queue/status");
    r.status(200).body().exists("$.drainerRunning");
  });
  await ctx.step("ANON → 401 on both", async () => {
    (await ctx.client.as(ctx.P.ANON).get("/v1/queue/all")).status(401);
    (await ctx.client.as(ctx.P.ANON).get("/v1/queue/status")).status(401);
  });
});

// ─── Q-2b: per-session read (unknown id = empty list, not 404) ────────────────

flow("Q-5", { domain: "queue", routes: ["GET /v1/queue/sessions/:sessionId"] }, async (ctx) => {
  const sessionId = uuid();
  await ctx.step("GET unknown session → 200 empty messages", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/queue/sessions/:sessionId", { params: { sessionId } });
    r.status(200).body().exists("$.messages");
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/queue/sessions/:sessionId", { params: { sessionId } });
    r.status(401);
  });
});

// ─── Q-1: enqueue lifecycle (enqueue → list → clear) ──────────────────────────

flow(
  "Q-1",
  {
    domain: "queue",
    serial: true,
    routes: ["POST /v1/queue/sessions/:sessionId", "GET /v1/queue/sessions/:sessionId", "DELETE /v1/queue/sessions/:sessionId"],
  },
  async (ctx) => {
    const sessionId = uuid();
    await ctx.step("enqueue a message → 201", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/sessions/:sessionId", { text: "hello from ke2e" }, { params: { sessionId } });
      r.status(201).body().exists("$.message");
    });
    await ctx.step("missing text → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/sessions/:sessionId", {}, { params: { sessionId } });
      r.status(400);
    });
    await ctx.step("list reflects the enqueued message → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/queue/sessions/:sessionId", { params: { sessionId } });
      r.status(200).body().exists("$.messages");
    });
    await ctx.step("clear session → 200 ok", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/queue/sessions/:sessionId", { params: { sessionId } });
      r.status(200).body().has("$.ok", true);
    });
    await ctx.step("enqueue ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/queue/sessions/:sessionId", { text: "x" }, { params: { sessionId } });
      r.status(401);
    });
  },
);

// ─── Q-3: message-level mutations (delete / reorder) ──────────────────────────

flow(
  "Q-3",
  {
    domain: "queue",
    serial: true,
    routes: [
      "DELETE /v1/queue/messages/:messageId",
      "POST /v1/queue/messages/:messageId/move-up",
      "POST /v1/queue/messages/:messageId/move-down",
    ],
  },
  async (ctx) => {
    const messageId = uuid();
    const sessionId = uuid();
    await ctx.step("delete unknown message → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/queue/messages/:messageId", { params: { messageId } });
      r.status(404);
    });
    await ctx.step("move-up without sessionId body → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-up", {}, { params: { messageId } });
      r.status(400);
    });
    await ctx.step("move-up unknown message → 400 (not found)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-up", { sessionId }, { params: { messageId } });
      r.status(400);
    });
    await ctx.step("move-down without sessionId body → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-down", {}, { params: { messageId } });
      r.status(400);
    });
    await ctx.step("move-down unknown message → 400 (not found)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-down", { sessionId }, { params: { messageId } });
      r.status(400);
    });
    await ctx.step("delete message ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).del("/v1/queue/messages/:messageId", { params: { messageId } });
      r.status(401);
    });
  },
);

// ─── Q-6: reorder roundtrip on a real two-message queue ───────────────────────

flow(
  "Q-6",
  {
    domain: "queue",
    serial: true,
    routes: [
      "POST /v1/queue/sessions/:sessionId",
      "POST /v1/queue/messages/:messageId/move-up",
      "POST /v1/queue/messages/:messageId/move-down",
      "DELETE /v1/queue/messages/:messageId",
      "DELETE /v1/queue/sessions/:sessionId",
    ],
  },
  async (ctx) => {
    const sessionId = uuid();
    let firstId = "";
    let secondId = "";
    await ctx.step("enqueue two messages", async () => {
      const a = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/sessions/:sessionId", { text: "first" }, { params: { sessionId } });
      a.status(201);
      firstId = a.json<any>().message?.id;
      const b = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/sessions/:sessionId", { text: "second" }, { params: { sessionId } });
      b.status(201);
      secondId = b.json<any>().message?.id;
    });
    await ctx.step("move second up → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-up", { sessionId }, { params: { messageId: secondId } });
      r.status([200, 400]);
    });
    await ctx.step("move it back down → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/queue/messages/:messageId/move-down", { sessionId }, { params: { messageId: secondId } });
      r.status([200, 400]);
    });
    await ctx.step("delete first message → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/queue/messages/:messageId", { params: { messageId: firstId } });
      r.status([200, 404]);
    });
    await ctx.step("clear session → 200 ok", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/queue/sessions/:sessionId", { params: { sessionId } });
      r.status(200).body().has("$.ok", true);
    });
  },
);
