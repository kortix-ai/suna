/**
 * Project secrets — manage-gated CRUD + validation. Maps to spec §19 (SEC-1/2/3).
 */
import { flow } from "../core/flow";

flow(
  "SEC-1",
  { domain: "secrets", routes: ["GET /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("list secret names", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      r.status(200);
    });
  },
);

flow(
  "SEC-2",
  { domain: "secrets", routes: ["POST /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("upsert a secret → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "MY_SECRET", value: "v1" }, { params: { projectId: p.id } });
      r.status([200, 201]);
    });
    await ctx.step("KORTIX_* reserved → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "KORTIX_HACK", value: "x" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("invalid name format → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "not a name!", value: "x" }, { params: { projectId: p.id } });
      r.status(400);
    });
  },
);

flow(
  "SEC-3",
  { domain: "secrets", routes: ["DELETE /v1/projects/:projectId/secrets/:name"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("create then delete a secret", async () => {
      await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secrets", { name: "TO_DELETE", value: "x" }, { params: { projectId: p.id } });
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/secrets/:name", { params: { projectId: p.id, name: "TO_DELETE" } });
      r.status(200);
    });
  },
);

flow(
  "SEC-6",
  { domain: "secrets", routes: ["POST /v1/projects/:projectId/secrets"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("two identifiers may share the same key (profile-like secrets)", async () => {
      const primary = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-primary", name: "GOOGLE_MAPS_API_KEY", value: "primary-key" },
          { params: { projectId: p.id } },
        );
      primary.status([200, 201]);
      primary.body().has("identifier", "GMAPS-primary").has("name", "GOOGLE_MAPS_API_KEY");

      const backup = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-backup", name: "GOOGLE_MAPS_API_KEY", value: "backup-key" },
          { params: { projectId: p.id } },
        );
      backup.status([200, 201]);
      backup.body().has("identifier", "GMAPS-backup").has("name", "GOOGLE_MAPS_API_KEY");

      const list = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      list.status(200);
      const items: any[] = list.json().items ?? [];
      const withKey = items.filter((i) => i.name === "GOOGLE_MAPS_API_KEY");
      if (withKey.length !== 2 || new Set(withKey.map((i) => i.identifier)).size !== 2) {
        throw new Error(`expected 2 distinct identifiers under GOOGLE_MAPS_API_KEY, got ${JSON.stringify(withKey)}`);
      }
    });

    await ctx.step("re-submitting the same identifier with a DIFFERENT key is rejected", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { identifier: "GMAPS-primary", name: "SOME_OTHER_KEY", value: "x" },
          { params: { projectId: p.id } },
        );
      r.status(409);
    });
  },
);
