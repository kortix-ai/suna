/**
 * Kortix Backends — a project owns up to 3 self-hosted Convex backends, each in
 * its own Platinum machine. Maps to spec section 33 (BKD-1).
 *
 * The local profile has no Platinum, so the `backends` flag is unavailable
 * here and the surface stays closed. This flow proves that closed state. The
 * provisioning path needs a real machine and is verified on a deployed
 * environment.
 */
import type { Res } from "../core/client";
import { flow } from "../core/flow";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

flow(
  "BKD-1",
  {
    domain: "backends",
    routes: [
      "PATCH /v1/projects/:projectId/features",
      "GET /v1/projects/:projectId/backends",
      "POST /v1/projects/:projectId/backends",
      "GET /v1/projects/:projectId/backends/:backendId",
      "GET /v1/projects/:projectId/backends/:backendId/credentials",
      "DELETE /v1/projects/:projectId/backends/:backendId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    const backendParams = { ...params, backendId: UNKNOWN_ID };

    const expectDisabled = (response: Res) => {
      response.status(403);
      response.body().has("$.code", "feature_disabled");
      response.body().has("$.feature", "backends");
    };

    await ctx.step("clear any backends flag override from a reused project", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "backends", enabled: null },
        { params },
      );
      response.status(200);
    });

    await ctx.step("flag off: list → 403 feature_disabled", async () => {
      expectDisabled(await owner.get("/v1/projects/:projectId/backends", { params }));
    });

    await ctx.step("flag off: create → 403 feature_disabled", async () => {
      expectDisabled(
        await owner.post("/v1/projects/:projectId/backends", { name: "main" }, { params }),
      );
    });

    await ctx.step("flag off: get, credentials, delete → 403 feature_disabled", async () => {
      expectDisabled(
        await owner.get("/v1/projects/:projectId/backends/:backendId", { params: backendParams }),
      );
      expectDisabled(
        await owner.get("/v1/projects/:projectId/backends/:backendId/credentials", {
          params: backendParams,
        }),
      );
      expectDisabled(
        await owner.del("/v1/projects/:projectId/backends/:backendId", { params: backendParams }),
      );
    });

    await ctx.step("enable the flag: open where Platinum is configured, closed (403) where not; never creates a machine", async () => {
      const enable = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "backends", enabled: true },
        { params },
      );
      enable.status(200);
      // An unavailable flag resolves off, so the effective value says which world this is.
      const effective = (enable.json() as { experimental?: { backends?: boolean } }).experimental?.backends;
      if (effective) {
        const list = await owner.get("/v1/projects/:projectId/backends", { params });
        list.status(200);
        if (!Array.isArray((list.json() as { backends?: unknown }).backends)) throw new Error("list has no backends array");
        // Validation answers before any machine is requested.
        (await owner.post("/v1/projects/:projectId/backends", { name: "Bad_Name" }, { params })).status(400);
      } else {
        expectDisabled(await owner.get("/v1/projects/:projectId/backends", { params }));
        expectDisabled(
          await owner.post("/v1/projects/:projectId/backends", { name: "main" }, { params }),
        );
      }
    });

    await ctx.step("NONMEMBER learns nothing: list and create → 403/404", async () => {
      const stranger = ctx.client.as(ctx.P.NONMEMBER);
      (await stranger.get("/v1/projects/:projectId/backends", { params })).status([403, 404]);
      (
        await stranger.post("/v1/projects/:projectId/backends", { name: "main" }, { params })
      ).status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      (await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/backends", { params })).status(401);
    });

    await ctx.step("cleanup: clear the flag override", async () => {
      (
        await owner.patch(
          "/v1/projects/:projectId/features",
          { feature: "backends", enabled: null },
          { params },
        )
      ).status(200);
    });
  },
);
