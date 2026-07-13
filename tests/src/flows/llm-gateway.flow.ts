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

flow(
  "GW-4",
  {
    domain: "llm-gateway",
    routes: [
      "GET /v1/projects/:projectId/gateway/routing-policy",
      "PUT /v1/projects/:projectId/gateway/routing-policy",
      "DELETE /v1/projects/:projectId/gateway/routing-policy",
      "POST /v1/projects/:projectId/gateway/routing-policy/preview",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const params = { projectId: project.id };
    const policy = {
      defaultModel: "codex/gpt-5.6-sol",
      visionModel: "glm-5.2",
      defaultFallback: { models: ["glm-5.2"], fallbackOn: "any-error" },
      rules: [
        {
          model: "openai/gpt-5.5",
          fallbackModels: ["glm-5.2"],
          fallbackOn: "transient",
        },
      ],
    };

    await ctx.step("inherited routing policy is readable", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/gateway/routing-policy", { params });
      r.status(200)
        .body()
        .has("$.version", 1)
        .has("$.project.defaultModel", null)
        .has("$.project.defaultFallback", null)
        .has("$.project.rules", [])
        .exists("$.effective.defaultModel")
        .has("$.capabilities.write", true);
    });

    await ctx.step("save and read back the complete project policy", async () => {
      const saved = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/gateway/routing-policy", policy, { params });
      saved.status(200)
        .body()
        .has("$.project", policy)
        .has("$.effective.defaultModel", "codex/gpt-5.6-sol")
        .has("$.effective.defaultFallback.models", ["glm-5.2"]);

      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/gateway/routing-policy", { params });
      read.status(200).body().has("$.project", policy);
    });

    await ctx.step("preview resolves ordered default and exact-model routes", async () => {
      const automatic = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/gateway/routing-policy/preview",
          { requestedModel: "auto", imageInput: false },
          { params },
        );
      automatic.status(200)
        .body()
        .has("$.route.policyId", "project:default")
        .has("$.route.primaryModel", "codex/gpt-5.6-sol")
        .has("$.route.fallbackModels", ["glm-5.2"])
        .has("$.route.fallbackOn", "any-error")
        .has("$.models[0].model", "codex/gpt-5.6-sol")
        .has("$.models[1].model", "glm-5.2")
        .exists("$.models[0].available")
        .exists("$.models[1].available");

      const exact = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/gateway/routing-policy/preview",
          { requestedModel: "openai/gpt-5.5", imageInput: false },
          { params },
        );
      exact.status(200)
        .body()
        .has("$.route.policyId", "project:exact:openai/gpt-5.5")
        .has("$.route.primaryModel", "openai/gpt-5.5")
        .has("$.route.fallbackModels", ["glm-5.2"])
        .has("$.route.fallbackOn", "transient");
    });

    await ctx.step("invalid self-loop is rejected without replacing the saved policy", async () => {
      const invalid = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/gateway/routing-policy",
          {
            ...policy,
            defaultFallback: { models: ["codex/gpt-5.6-sol"], fallbackOn: "any-error" },
          },
          { params },
        );
      invalid.status(400).body().has("$.code", "invalid_routing_policy");

      const read = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/gateway/routing-policy", { params });
      read.status(200).body().has("$.project", policy);
    });

    await ctx.step("project access boundaries are enforced", async () => {
      const nonmember = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/gateway/routing-policy", { params });
      nonmember.status([403, 404]);
      const anonymous = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/gateway/routing-policy", { params });
      anonymous.status(401);
    });

    await ctx.step("reset removes every project override", async () => {
      const reset = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/gateway/routing-policy", { params });
      reset.status(200)
        .body()
        .has("$.project.defaultModel", null)
        .has("$.project.visionModel", null)
        .has("$.project.defaultFallback", null)
        .has("$.project.rules", []);
    });
  },
);
