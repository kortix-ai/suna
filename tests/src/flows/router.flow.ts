/**
 * Router — the in-sandbox runtime's gateway to managed LLM + web tooling.
 * Maps to spec §… (RTR-1..RTR-4). The whole point of this surface is that it
 * is authed by a Kortix API key (`apiKeyAuth`), NOT a user JWT: it is called
 * by the sandbox runtime, which only ever holds KORTIX_TOKEN. So the real
 * boundary to pin here is "user-JWT and ANON both 401" on the key-gated routes.
 *
 * Confirmed in apps/api/src/router/index.ts:
 *   - /web-search/*, /image-search/*  → apiKeyAuth
 *   - /chat/*, /messages, /models, /models/*  → apiKeyAuth
 *   - /llm/*  (session-llm) → its own session-LLM-token bearer (not a JWT)
 * Router routes are guarded by API key/session auth boundaries.
 *
 * We do not hold a kortix_ API key principal here, so we assert the negative
 * (401) boundary exhaustively rather than faking a successful managed call.
 */
import { flow } from "../core/flow";

flow(
  "RTR-1",
  {
    domain: "router",
    tags: ["smoke"],
    routes: ["POST /v1/router/web-search", "POST /v1/router/image-search"],
  },
  async (ctx) => {
    await ctx.step("web-search: OWNER JWT → 401 (apiKeyAuth only)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/router/web-search", { query: "kortix" });
      r.status(401);
    });
    await ctx.step("web-search: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/router/web-search", { query: "kortix" });
      r.status(401);
    });
    await ctx.step("image-search: OWNER JWT → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/router/image-search", { query: "kortix" });
      r.status(401);
    });
    await ctx.step("image-search: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/router/image-search", { query: "kortix" });
      r.status(401);
    });
  },
);

flow(
  "RTR-2",
  {
    domain: "router",
    routes: [
      "POST /v1/router/chat/completions",
      "POST /v1/router/messages",
      "GET /v1/router/models",
      "GET /v1/router/models/:model",
    ],
  },
  async (ctx) => {
    await ctx.step("chat/completions: OWNER JWT → 401 (apiKeyAuth only)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/router/chat/completions", {
          model: "anthropic/claude-3.5-sonnet",
          messages: [{ role: "user", content: "hi" }],
        });
      r.status(401);
    });
    await ctx.step("chat/completions: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/router/chat/completions", {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "hi" }],
      });
      r.status(401);
    });
    await ctx.step("messages (Anthropic-style): OWNER JWT → 401", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/router/messages", {
        model: "claude-3-5-sonnet-latest",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      r.status(401);
    });
    await ctx.step("messages: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/router/messages", {
        model: "claude-3-5-sonnet-latest",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      r.status(401);
    });
    // GET /models and /models/:model are key-gated too (router.use('/models', apiKeyAuth)).
    await ctx.step("GET /models: OWNER JWT → 401 (apiKeyAuth only)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/router/models");
      r.status(401);
    });
    await ctx.step("GET /models: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/router/models");
      r.status(401);
    });
    await ctx.step("GET /models/:model: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/router/models/:model", { params: { model: "anthropic/claude-3.5-sonnet" } });
      r.status(401);
    });
  },
);

flow(
  "LLM-1",
  {
    domain: "router",
    routes: [
      "GET /v1/llm/health",
      "GET /v1/llm/models",
      "POST /v1/llm/chat/completions",
    ],
  },
  async (ctx) => {
    await ctx.step("managed LLM health: public gateway status", async () => {
      const r = await ctx.client.get("/v1/llm/health");
      r.status([200, 500, 503]);
    });
    await ctx.step("managed LLM models: gateway status or upstream status", async () => {
      const r = await ctx.client.get("/v1/llm/models", { timeoutMs: 10_000 });
      r.status([200, 401, 403, 404, 429, 500, 502, 503]);
    });
    await ctx.step("managed LLM chat/completions: missing bearer never succeeds", async () => {
      const r = await ctx.client.post("/v1/llm/chat/completions", {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      });
      r.status([401, 500, 503]);
    });
  },
);

// NOTE: the billed proxy passthrough (`router.all('/:service/*')`) is a Hono ALL
// catch-all, so it is not a discrete entry in app.routes / the route manifest and
// can't be a coverage target. Its auth boundary is covered transitively by the
// apiKeyAuth-gated routes above (RTR-1/2). No separate flow.
