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
