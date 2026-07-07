/**
 * Project triggers — manage-gated CRUD. Maps to spec §17 (TRG-1..5).
 * Trigger create commits the project manifest (a real git commit).
 */
import { flow } from "../core/flow";

flow("TRG-1", { domain: "triggers", routes: ["GET /v1/projects/:projectId/triggers"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("list triggers", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/triggers", { params: { projectId: p.id } });
    r.status(200);
  });
  // project.trigger.read gate (IAM enforcement audit) — a stranger with no
  // project access at all still 404s (loadProjectForUser denies before the
  // leaf assert is reached); the leaf itself is proven at the unit/integration
  // level (unit-iam-v2-role-perms + integration-project-read-leaf-gates-http),
  // since the built-in floor role always carries project.trigger.read and this
  // suite has no custom-role fixture to withhold just that leaf.
  await ctx.step("NONMEMBER → 403/404", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/triggers", { params: { projectId: p.id } });
    r.status([403, 404]);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/triggers", { params: { projectId: p.id } });
    r.status(401);
  });
});

flow(
  "TRG-2",
  { domain: "triggers", routes: ["POST /v1/projects/:projectId/triggers"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("create a cron trigger with a pinned model → 201", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/triggers",
        {
          name: "Nightly",
          type: "cron",
          cron: "0 0 3 * * *",
          timezone: "UTC",
          prompt_template: "do nightly work",
          model: "anthropic/claude-sonnet-4-6",
        },
        { params: { projectId: p.id } },
      );
      r.status(201).body().has("triggers[0].model", "anthropic/claude-sonnet-4-6");
    });
    await ctx.step("duplicate slug → 409", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/projects/:projectId/triggers",
        { name: "Nightly", type: "cron", cron: "0 0 3 * * *", timezone: "UTC", prompt_template: "again" },
        { params: { projectId: p.id } },
      );
      r.status(409);
    });
  },
);

flow(
  "TRG-3",
  { domain: "triggers", routes: ["PATCH /v1/projects/:projectId/triggers/:slug"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.client.as(ctx.P.OWNER).post(
      "/v1/projects/:projectId/triggers",
      { name: "Toggle Me", type: "cron", cron: "0 0 3 * * *", timezone: "UTC", prompt_template: "x" },
      { params: { projectId: p.id } },
    );
    await ctx.step("disable trigger → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/projects/:projectId/triggers/:slug", { enabled: false }, { params: { projectId: p.id, slug: "toggle-me" } });
      r.status(200);
    });
    // Regression: a PATCH body with ONLY `model` must still persist — it was
    // previously dropped silently (manifest-key allowlist omitted "model").
    await ctx.step("patch model only → persists", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch(
          "/v1/projects/:projectId/triggers/:slug",
          { model: "openai/gpt-5" },
          { params: { projectId: p.id, slug: "toggle-me" } },
        );
      r.status(200).body().has("triggers[0].model", "openai/gpt-5");
    });
  },
);

flow(
  "TRG-4",
  { domain: "triggers", routes: ["DELETE /v1/projects/:projectId/triggers/:slug"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.client.as(ctx.P.OWNER).post(
      "/v1/projects/:projectId/triggers",
      { name: "Delete Me", type: "cron", cron: "0 0 3 * * *", timezone: "UTC", prompt_template: "x" },
      { params: { projectId: p.id } },
    );
    await ctx.step("delete trigger → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/triggers/:slug", { params: { projectId: p.id, slug: "delete-me" } });
      r.status(200);
    });
  },
);

// TRG-10 — GET /triggers is leaf-gated on project.trigger.read (IAM enforcement
// audit). The built-in floor role always carries trigger.read, so the only way
// to withhold JUST that leaf is a custom (Enterprise) role. A member bound to a
// custom project role granting project.read but NOT project.trigger.read can
// still load the project (read passes) yet is rejected 403 at GET /triggers —
// the leaf assert firing exactly where the audit wanted it. A second member on
// the built-in floor role (which includes trigger.read) still gets 200, proving
// the gate isn't a blanket denial.
flow(
  "TRG-10",
  {
    domain: "triggers",
    routes: [
      "GET /v1/projects/:projectId/triggers",
      "PUT /v1/accounts/:accountId/iam/enterprise-demo",
      "POST /v1/accounts/:accountId/iam/roles",
      "POST /v1/accounts/:accountId/iam/policies",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const noTriggerRead = await team.addMember("member");
    const floorMember = await team.addMember("member");
    const roleKey = `notrig_${team.id.replace(/-/g, "").slice(0, 10)}`;
    let roleId = "";

    await ctx.step("enable enterprise-demo (entitles this account for custom-role writes)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/accounts/:accountId/iam/enterprise-demo", { enabled: true }, { params: { accountId: team.id } });
      r.status(200).body().has("$.enabled", true);
    });

    await ctx.step("create a custom project role with project.read but NOT project.trigger.read", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/roles",
        { key: roleKey, name: "No trigger read", resourceType: "project", actions: ["project.read"] },
        { params: { accountId: team.id } },
      );
      r.status(201);
      roleId = r.json<any>().role_id;
    });

    await ctx.step("bind that member to the custom role on this project", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/policies",
        {
          principalType: "member",
          principalId: noTriggerRead.userId!,
          roleId,
          scopeType: "project",
          scopeId: project.id,
        },
        { params: { accountId: team.id } },
      );
      r.status(201);
    });

    await ctx.step("member WITHOUT trigger.read → GET /triggers 403 (leaf gate)", async () => {
      const r = await ctx.client
        .as(noTriggerRead)
        .get("/v1/projects/:projectId/triggers", { params: { projectId: project.id } });
      r.status(403);
    });

    await ctx.step("floor member WITH trigger.read → GET /triggers 200", async () => {
      await team.grantProjectRole(project.id, floorMember.userId!, "user");
      const r = await ctx.client
        .as(floorMember)
        .get("/v1/projects/:projectId/triggers", { params: { projectId: project.id } });
      r.status(200);
    });
  },
);
