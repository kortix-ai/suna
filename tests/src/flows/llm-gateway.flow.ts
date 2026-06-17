import { flow } from "../core/flow";
import { Client } from "../core/client";

flow(
  "GW-1",
  { domain: "llm-gateway", tags: ["smoke"], routes: ["GET /health"] },
  async (ctx) => {
    const gw = new Client(ctx.env.gatewayUrl);
    await ctx.step("gateway /health is public", async () => {
      const r = await gw.get("/health");
      r.status(200).body().exists("$.ok");
    });
  },
);

flow(
  "GW-2",
  {
    domain: "llm-gateway",
    todo: "GET /v1/llm/models (+ /v1/models, /v1/openai/models) returns 500 'Internal Server Error' on gateway-dev for an authed funded OWNER; should be 200 with the model catalog. Flip to assert 200 + $.data once the gateway model-list bug is fixed.",
    routes: ["GET /v1/llm/models", "GET /v1/models", "GET /v1/openai/models"],
  },
  async () => {},
);

flow(
  "GW-2b",
  { domain: "llm-gateway", routes: ["GET /v1/llm/models"] },
  async (ctx) => {
    const gw = new Client(ctx.env.gatewayUrl);
    await ctx.step("ANON cannot list models", async () => {
      const r = await gw.as(ctx.P.ANON).get("/v1/llm/models");
      r.status([401, 403]);
    });
  },
);

flow(
  "GW-3",
  {
    domain: "llm-gateway",
    routes: [
      "POST /v1/chat/completions",
      "POST /v1/llm/chat/completions",
      "POST /v1/openai/chat/completions",
    ],
  },
  async (ctx) => {
    const gw = new Client(ctx.env.gatewayUrl);
    const body = { model: "gpt-5.5", messages: [{ role: "user", content: "ping" }] };
    await ctx.step("ANON cannot call /v1/llm/chat/completions", async () => {
      const r = await gw.as(ctx.P.ANON).post("/v1/llm/chat/completions", body);
      r.status([401, 403]);
    });
    await ctx.step("ANON cannot call /v1/chat/completions alias", async () => {
      const r = await gw.as(ctx.P.ANON).post("/v1/chat/completions", body);
      r.status([401, 403]);
    });
    await ctx.step("ANON cannot call /v1/openai/chat/completions alias", async () => {
      const r = await gw.as(ctx.P.ANON).post("/v1/openai/chat/completions", body);
      r.status([401, 403]);
    });
  },
);
