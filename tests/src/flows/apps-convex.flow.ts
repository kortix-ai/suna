/**
 * Apps of kind `convex` and the capability routes. A `convex` App is a
 * self-hosted Convex backend in its own Platinum machine; clients branch on
 * `capabilities`, never on `kind`. Maps to spec section 34 (APP-9).
 *
 * The local profile has no Platinum, so a `convex` create answers 409
 * `app_kind_unavailable` here, and the capability routes are proven on a web
 * App, which lacks every one of them (409 `app_capability_unsupported`). The
 * machine path (provision, snapshots, restore, credentials, retention) is
 * proven by the DB suites `apps/api/src/apps/kinds/convex/*.integration.test.ts`
 * against a fake Platinum, and on a deployed environment.
 */
import { flow } from "../core/flow";
import { setFeatureAsOperator } from "../fixtures/feature-flags";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

const CAPABILITY_ROUTES = [
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/snapshots", capability: "snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/snapshots", capability: "snapshots" },
  { method: "del", path: "/v1/projects/:projectId/apps/:appId/snapshots/:snapshotId", capability: "snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/restore", capability: "restore" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/credentials", capability: "admin_credentials" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/rotate-credentials", capability: "admin_credentials" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/token", capability: "member_tokens" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/logs", capability: "logs" },
] as const;

flow(
  "APP-9",
  {
    domain: "apps",
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId/snapshots",
      "POST /v1/projects/:projectId/apps/:appId/snapshots",
      "DELETE /v1/projects/:projectId/apps/:appId/snapshots/:snapshotId",
      "POST /v1/projects/:projectId/apps/:appId/restore",
      "GET /v1/projects/:projectId/apps/:appId/credentials",
      "POST /v1/projects/:projectId/apps/:appId/rotate-credentials",
      "POST /v1/projects/:projectId/apps/:appId/token",
      "GET /v1/projects/:projectId/apps/:appId/logs",
      "GET /v1/backends/:backendId/.well-known/openid-configuration",
      "GET /v1/backends/:backendId/jwks.json",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    let webAppId = "";

    await ctx.step("apps flag off: a convex create and every capability route answer 403 feature_disabled", async () => {
      await setFeatureAsOperator(ctx, project.id, "apps", null);
      const create = await owner.post(
        "/v1/projects/:projectId/apps",
        { kind: "convex", slug: "main", name: "main" },
        { params: projectParams },
      );
      create.status(403).body().has("$.code", "feature_disabled").has("$.feature", "apps");
      const params = { ...projectParams, appId: UNKNOWN_ID, snapshotId: "snap_none" };
      for (const route of CAPABILITY_ROUTES) {
        const body = route.path.endsWith("/restore") ? { snapshot_id: "snap_none" } : {};
        const response =
          route.method === "get" || route.method === "del"
            ? await owner[route.method](route.path, { params })
            : await owner.post(route.path, body, { params });
        response.status(403).body().has("$.code", "feature_disabled");
      }
    });

    await ctx.step("an operator enables apps; an invalid kind or slug answers 400 before any machine is requested", async () => {
      await setFeatureAsOperator(ctx, project.id, "apps", true);
      (
        await owner.post("/v1/projects/:projectId/apps", { kind: "mysql", slug: "db", name: "db" }, { params: projectParams })
      ).status(400);
      (
        await owner.post("/v1/projects/:projectId/apps", { kind: "convex", slug: "Bad Slug", name: "x" }, { params: projectParams })
      ).status(400);
    });

    await ctx.step("a convex create: 201 provisioning where Platinum is configured, else 409 app_kind_unavailable; always_on false → 400", async () => {
      (
        await owner.post(
          "/v1/projects/:projectId/apps",
          { kind: "convex", slug: "sleepy", name: "sleepy", always_on: false },
          { params: projectParams },
        )
      )
        .status([400, 409])
        .body()
        .exists("$.code");
      const create = await owner.post(
        "/v1/projects/:projectId/apps",
        { kind: "convex", slug: "main", name: "main", uses: [] },
        { params: projectParams },
      );
      create.status([201, 409]);
      if (create.statusCode === 409) {
        create.body().has("$.code", "app_kind_unavailable");
      } else {
        create
          .body()
          .has("$.kind", "convex")
          .has("$.always_on", true)
          .has("$.instance.status", "provisioning")
          .has("$.capabilities", ["deployments", "snapshots", "restore", "admin_credentials", "dashboard", "logs", "member_tokens"]);
      }
    });

    await ctx.step("a web App lacks every capability route: 409 app_capability_unsupported naming the capability", async () => {
      const created = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug: ctx.fixtures.name("site").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40), name: "site" },
        { params: projectParams },
      );
      created.status(201).body().has("$.kind", "web").has("$.capabilities", ["deployments", "rollback", "preview"]);
      webAppId = created.json<{ app_id: string }>().app_id;
      const params = { ...projectParams, appId: webAppId, snapshotId: "snap_none" };
      for (const route of CAPABILITY_ROUTES) {
        const body = route.path.endsWith("/restore") ? { snapshot_id: "snap_none" } : {};
        const response =
          route.method === "get" || route.method === "del"
            ? await owner[route.method](route.path, { params })
            : await owner.post(route.path, body, { params });
        response
          .status(409)
          .body()
          .has("$.code", "app_capability_unsupported")
          .has("$.capability", route.capability)
          .has("$.kind", "web");
      }
    });

    await ctx.step("an unknown App answers 404 on a capability route", async () => {
      (
        await owner.get("/v1/projects/:projectId/apps/:appId/snapshots", {
          params: { ...projectParams, appId: UNKNOWN_ID },
        })
      ).status(404);
    });

    await ctx.step("NONMEMBER learns nothing (403/404); ANON → 401", async () => {
      const params = { ...projectParams, appId: webAppId };
      (await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/apps/:appId/credentials", { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/apps/:appId/credentials", { params })).status(401);
    });

    await ctx.step("ANON issuer discovery: an unknown App → 404, a malformed id → 400", async () => {
      const anon = ctx.client.as(ctx.P.ANON);
      (
        await anon.get("/v1/backends/:backendId/.well-known/openid-configuration", {
          params: { backendId: UNKNOWN_ID },
        })
      ).status(404);
      (await anon.get("/v1/backends/:backendId/jwks.json", { params: { backendId: UNKNOWN_ID } })).status(404);
      (await anon.get("/v1/backends/:backendId/jwks.json", { params: { backendId: "not-a-uuid" } })).status(400);
    });

    await ctx.step("cleanup: delete the web App, clear the flag override", async () => {
      if (webAppId) {
        (await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId: webAppId } })).status(200);
      }
      await setFeatureAsOperator(ctx, project.id, "apps", null);
    });
  },
);
