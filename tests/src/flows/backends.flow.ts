/**
 * Kortix Backends — a project owns up to 3 self-hosted Convex backends, each in
 * its own Platinum machine. Maps to spec section 34 (BKD-1).
 *
 * `backends` is internal-only: a project owner gets 403
 * `feature_operator_only` on `PATCH /features`; the run-scoped platform
 * operator writes it through `PUT /v1/admin/api/projects/:id/features`.
 *
 * The local profile has no Platinum, so the `backends` flag is unavailable
 * here and the surface stays closed. This flow proves that closed state. The
 * provisioning path needs a real machine and is verified on a deployed
 * environment.
 */
import type { Res } from "../core/client";
import { flow } from "../core/flow";
import { setFeatureAsOperator } from "../fixtures/feature-flags";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

flow(
  "BKD-1",
  {
    domain: "backends",
    routes: [
      "PATCH /v1/projects/:projectId/features",
      "PUT /v1/admin/api/projects/:id/features",
      "GET /v1/projects/:projectId/backends",
      "POST /v1/projects/:projectId/backends",
      "GET /v1/projects/:projectId/backends/:backendId",
      "GET /v1/projects/:projectId/backends/:backendId/credentials",
      "DELETE /v1/projects/:projectId/backends/:backendId",
      "PATCH /v1/projects/:projectId/backends/:backendId",
      "POST /v1/projects/:projectId/backends/:backendId/token",
      "GET /v1/projects/:projectId/backends/:backendId/backups",
      "POST /v1/projects/:projectId/backends/:backendId/snapshots",
      "DELETE /v1/projects/:projectId/backends/:backendId/snapshots/:snapshotId",
      "POST /v1/projects/:projectId/backends/:backendId/restore",
      "POST /v1/projects/:projectId/backends/:backendId/rotate-admin-key",
      "GET /v1/projects/:projectId/backends/:backendId/logs",
      "GET /v1/backends/:backendId/.well-known/openid-configuration",
      "GET /v1/backends/:backendId/jwks.json",
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

    await ctx.step("clear any backends flag override from a reused project (operator route)", async () => {
      await setFeatureAsOperator(ctx, project.id, "backends", null);
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

    await ctx.step("flag off: resize, token, backups, snapshot, delete snapshot, restore → 403 feature_disabled", async () => {
      expectDisabled(
        await owner.patch("/v1/projects/:projectId/backends/:backendId", { cpu: 2 }, { params: backendParams }),
      );
      expectDisabled(
        await owner.post("/v1/projects/:projectId/backends/:backendId/token", {}, { params: backendParams }),
      );
      expectDisabled(
        await owner.get("/v1/projects/:projectId/backends/:backendId/backups", { params: backendParams }),
      );
      expectDisabled(
        await owner.post("/v1/projects/:projectId/backends/:backendId/snapshots", {}, { params: backendParams }),
      );
      expectDisabled(
        await owner.del("/v1/projects/:projectId/backends/:backendId/snapshots/:snapshotId", {
          params: { ...backendParams, snapshotId: "snap_none" },
        }),
      );
      expectDisabled(
        await owner.post(
          "/v1/projects/:projectId/backends/:backendId/restore",
          { snapshot_id: "snap_none" },
          { params: backendParams },
        ),
      );
    });

    await ctx.step("flag off: rotate-admin-key, logs → 403 feature_disabled", async () => {
      expectDisabled(
        await owner.post("/v1/projects/:projectId/backends/:backendId/rotate-admin-key", {}, { params: backendParams }),
      );
      expectDisabled(
        await owner.get("/v1/projects/:projectId/backends/:backendId/logs", { params: backendParams }),
      );
    });

    await ctx.step("the owner cannot enable, disable or clear backends: /features → 403 feature_operator_only", async () => {
      for (const enabled of [true, false, null]) {
        const response = await owner.patch(
          "/v1/projects/:projectId/features",
          { feature: "backends", enabled },
          { params },
        );
        response.status(403);
        response.body().has("$.code", "feature_operator_only");
        response.body().has("$.feature", "backends");
      }
    });

    await ctx.step("a non-operator cannot use the operator route → 403", async () => {
      (
        await owner.put(
          "/v1/admin/api/projects/:id/features",
          { feature: "backends", enabled: true },
          { params: { id: project.id } },
        )
      ).status(403);
    });

    await ctx.step("an operator enables the flag: open where Platinum is configured, closed (403) where not; never creates a machine", async () => {
      // An unavailable flag resolves off, so the effective value says which world this is.
      const { enabled: effective } = await setFeatureAsOperator(ctx, project.id, "backends", true);
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

    await ctx.step("ANON issuer discovery: an unknown backend → 404, a malformed id → 400", async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (
        await anon.get("/v1/backends/:backendId/.well-known/openid-configuration", {
          params: { backendId: UNKNOWN_ID },
        })
      ).status(404);
      (await anon.get("/v1/backends/:backendId/jwks.json", { params: { backendId: UNKNOWN_ID } })).status(404);
      (await anon.get("/v1/backends/:backendId/jwks.json", { params: { backendId: "not-a-uuid" } })).status(400);
    });

    await ctx.step("cleanup: clear the flag override (operator route)", async () => {
      await setFeatureAsOperator(ctx, project.id, "backends", null);
    });
  },
);
