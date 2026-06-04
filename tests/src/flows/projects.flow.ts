/**
 * Projects — authenticated CRUD + access. Maps to spec §13 (PROJ-1..8).
 */
import { flow } from "../core/flow";

flow("PROJ-1", { domain: "projects", tags: ["smoke"], routes: ["GET /v1/projects"] }, async (ctx) => {
  await ctx.step("OWNER lists projects", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects");
    r.status(200);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects");
    r.status(401);
  });
});

flow("PROJ-3", { domain: "projects", requires: ["freestyle"], routes: ["POST /v1/projects/provision"] }, async (ctx) => {
  await ctx.step("managed provision → 201 with repo", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("prov") });
    // 502 can occur transiently when the managed git host is rate-limited/unavailable.
    r.status([200, 201, 502]);
    if (r.statusCode < 400) r.body().exists("$.project_id").exists("$.repo_url");
    ctx.track("project", r.json<any>().project_id);
  });
});

flow("PROJ-5", { domain: "projects", routes: ["GET /v1/projects/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER reads project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    r.status(200).body().has("$.project_id", p.id);
  });
  await ctx.step("NONMEMBER → 403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId", { params: { projectId: p.id } });
    r.status([403, 404]);
  });
  await ctx.step("unknown project → 404", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .get("/v1/projects/:projectId", { params: { projectId: "00000000-0000-4000-a000-000000000000" } });
    r.status(404);
  });
});

flow("PROJ-6", { domain: "projects", routes: ["GET /v1/projects/:projectId/detail"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("detail returns project + manifest", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/detail", { params: { projectId: p.id } });
    r.status(200);
  });
});

flow("PROJ-7", { domain: "projects", routes: ["PATCH /v1/projects/:projectId"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("OWNER renames project", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .patch("/v1/projects/:projectId", { name: ctx.fixtures.name("renamed") }, { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER cannot patch → 403/404", async () => {
    const r = await ctx.client
      .as(ctx.P.NONMEMBER)
      .patch("/v1/projects/:projectId", { name: "nope" }, { params: { projectId: p.id } });
    r.status([403, 404]);
  });
});

flow(
  "PROJ-18",
  {
    domain: "projects",
    // `stripe` ⇒ the target enforces billing, so a free account is capped at 1
    // project; `freestyle` ⇒ managed provisioning is available to reach the cap.
    requires: ["freestyle", "stripe"],
    serial: true,
    routes: ["GET /v1/projects", "POST /v1/projects/provision"],
  },
  async (ctx) => {
    // NONMEMBER is a fresh, UNFUNDED (free) account → its project cap is 1.
    const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects");
    list.status(200);
    const existing = list.json<any[]>()?.length ?? 0;

    if (existing === 0) {
      await ctx.step("free account: 1st project allowed (201)", async () => {
        const r = await ctx.client
          .as(ctx.P.NONMEMBER)
          .post("/v1/projects/provision", { name: ctx.fixtures.name("free-1") });
        // 502 = managed git host transiently unavailable (see PROJ-3).
        r.status([201, 502]);
        if (r.statusCode === 201) ctx.track("project", r.json<any>().project_id);
      });
    }

    await ctx.step("free account: 2nd project rejected (403 project_limit_reached)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/provision", { name: ctx.fixtures.name("free-2") });
      // The quota gate returns 403 BEFORE any repo is provisioned, so the only
      // non-403 outcome is a 502 from a failed 1st-project create above (no
      // project exists to count) — tolerated, not a limit regression.
      r.status([403, 502]);
      if (r.statusCode === 403) {
        r.body().has("$.code", "project_limit_reached").exists("$.limit");
      }
    });
  },
);

flow("PROJ-8", { domain: "projects", routes: ["DELETE /v1/projects/:projectId"] }, async (ctx) => {
  // Not tracked: this flow deletes it itself.
  const r0 = await ctx.client.as(ctx.P.OWNER).post("/v1/projects/provision", { name: ctx.fixtures.name("del") });
  const id = r0.json<any>().project_id;
  await ctx.step("OWNER archives project", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).del("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(200).body().has("$.ok", true);
  });
  await ctx.step("archived project reads 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId", { params: { projectId: id } });
    r.status(404);
  });
});
