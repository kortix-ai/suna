/**
 * Router — the in-sandbox runtime's gateway to managed LLM + web tooling.
 * Maps to spec §… (RTR-1..RTR-4). The whole point of this surface is that it
 * is authed by a Kortix API key (`apiKeyAuth`), NOT a user JWT: it is called
 * by the sandbox runtime, which only ever holds KORTIX_TOKEN. So the real
 * boundary to pin here is "user-JWT and ANON both 401" on the key-gated routes.
 *
 * Confirmed in apps/api/src/router/index.ts:
 *   - /web-search/*, /image-search/*  → apiKeyAuth
 *   - /chat/*, /models, /models/*  → apiKeyAuth
 * Router routes are guarded by API key/session auth boundaries.
 *
 * The legacy Anthropic-passthrough `POST /router/messages` (OpenRouter-billed,
 * platform-key-only, legacy LLM-credits ledger) was removed — the Anthropic
 * Messages API shape is now served by the gateway's own ingress at
 * `POST /v1/llm/messages` (see llm-gateway.flow.ts, spec §GW-6), which runs
 * through the same BYOK-capable auth/billing pipeline as chat.completions.
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

// NOTE: the billed proxy passthrough (`router.all('/:service/*')`) is a Hono ALL
// catch-all, so it is not a discrete entry in app.routes / the route manifest and
// can't be a coverage target. Its auth boundary is covered transitively by the
// apiKeyAuth-gated routes above (RTR-1/2). No separate flow.
