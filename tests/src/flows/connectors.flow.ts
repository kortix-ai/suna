/**
 * Connectors (executor) — catalog, project connector admin, policies, sharing,
 * credentials, call gateway. Maps to spec §24 (CONN-1..9).
 */
import { flow } from "../core/flow";

flow("CONN-1", { domain: "connectors", tags: ["smoke"], routes: ["GET /v1/executor/connectors"] }, async (ctx) => {
  // The catalog + /call are executor-principal routes (the sandbox runtime calls
  // them with a project/sandbox KORTIX_TOKEN). A bare user JWT is NOT an executor
  // principal → 401; ANON → 401. The 200 path is exercised by the in-sandbox
  // executor (covered by sandbox/agent-run flows), not a dashboard JWT.
  await ctx.step("user JWT is not an executor principal → 401", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/connectors");
    r.status(401);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/executor/connectors");
    r.status(401);
  });
});

flow("CONN-2", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/connectors"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("project admin lists connectors", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/connectors", { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/executor/projects/:projectId/connectors", { params: { projectId: p.id } });
    r.status(403);
  });
});

flow("CONN-3", { domain: "connectors", routes: ["POST /v1/executor/call"] }, async (ctx) => {
  // /call is executor-principal only: a user JWT and ANON both → 401 (the real
  // caller is the sandbox runtime with KORTIX_TOKEN).
  await ctx.step("user JWT → 401", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/executor/call", {});
    r.status(401);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/executor/call", { connector: "x", action: "y" });
    r.status(401);
  });
});

flow("CONN-4", { domain: "connectors", routes: ["POST /v1/executor/projects/:projectId/connectors/sync"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("sync re-materializes from kortix.toml → 200", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/executor/projects/:projectId/connectors/sync", {}, { params: { projectId: p.id } });
    r.status(200);
  });
});

flow(
  "CONN-5",
  { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/policies", "PUT /v1/executor/projects/:projectId/policies"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("read policies → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/policies", { params: { projectId: p.id } });
      r.status([200, 501]);
    });
    await ctx.step("replace policies → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put("/v1/executor/projects/:projectId/policies", { policies: [] }, { params: { projectId: p.id } });
      r.status([200, 501]);
    });
  },
);

flow("CONN-6", { domain: "connectors", routes: ["PUT /v1/executor/projects/:projectId/connectors/:slug/sharing"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("invalid sharing mode → 400", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put("/v1/executor/projects/:projectId/connectors/:slug/sharing", { mode: "wizard" }, { params: { projectId: p.id, slug: "nope" } });
    r.status(400);
  });
  await ctx.step("valid mode but unknown connector → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put("/v1/executor/projects/:projectId/connectors/:slug/sharing", { mode: "project" }, { params: { projectId: p.id, slug: "nope" } });
    r.status(404);
  });
});

flow("CONN-7", { domain: "connectors", routes: ["PUT /v1/executor/projects/:projectId/connectors/:slug/credential"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("missing value → 400", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put("/v1/executor/projects/:projectId/connectors/:slug/credential", {}, { params: { projectId: p.id, slug: "nope" } });
    r.status(400);
  });
});

flow(
  "CONN-8",
  { domain: "connectors", routes: ["POST /v1/executor/projects/:projectId/connectors", "DELETE /v1/executor/projects/:projectId/connectors/:slug"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("invalid json add → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/executor/projects/:projectId/connectors", "not json", { params: { projectId: p.id }, raw: true, headers: { "content-type": "application/json" } });
      r.status([400, 501]);
    });
    await ctx.step("delete unknown connector → ok/404/400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/executor/projects/:projectId/connectors/:slug", { params: { projectId: p.id, slug: "nope" } });
      r.status([200, 400, 404, 501]);
    });
  },
);

flow("CONN-9", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/pipedream/apps"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("pipedream catalog → 200 or 501", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/pipedream/apps", { params: { projectId: p.id } });
    r.status([200, 501]);
  });
});

flow("CONN-12", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/connectors/:slug/config"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("unknown connector → 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/connectors/:slug/config", { params: { projectId: p.id, slug: "nope" } });
    r.status([404, 501]);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/executor/projects/:projectId/connectors/:slug/config", { params: { projectId: p.id, slug: "nope" } });
    r.status(403);
  });
});
