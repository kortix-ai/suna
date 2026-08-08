/**
 * Kortix Apps — project-owned serverless App CRUD, artifact registration, and
 * deployment lifecycle boundaries. Maps to spec section 28 (APP-1..2).
 */
import { flow } from "../core/flow";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

flow(
  "APP-1",
  {
    domain: "apps",
    routes: [
      "GET /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId",
      "PATCH /v1/projects/:projectId/apps/:appId",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "GET /v1/projects/:projectId/apps/:appId/access",
      "PATCH /v1/projects/:projectId/apps/:appId/access",
      "POST /v1/projects/:projectId/apps/:appId/access-session",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    let appId = "";

    await ctx.step("apps flag off (default) → 403 feature_disabled", async () => {
      const response = await owner.get("/v1/projects/:projectId/apps", {
        params: projectParams,
      });
      response.status(403);
      response.body().has("$.code", "feature_disabled");
      response.body().has("$.feature", "apps");
    });

    await ctx.step("enable the apps flag (canonical /features route)", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(200);
    });

    await ctx.step("list starts empty", async () => {
      const response = await owner.get("/v1/projects/:projectId/apps", {
        params: projectParams,
      });
      response.status(200).body().has("$.apps", []);
    });

    await ctx.step("invalid slug is rejected", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug: "Invalid Slug", name: "Invalid App" },
        { params: projectParams },
      );
      response.status(400);
    });

    await ctx.step("create returns stable App policy and URL", async () => {
      const slug = ctx.fixtures
        .name("app")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 63);
      const response = await owner.post(
        "/v1/projects/:projectId/apps",
        {
          slug,
          name: "ke2e App",
          cpu: 1,
          memory_gb: 2,
          disk_gb: 10,
          idle_timeout_seconds: 300,
          monthly_budget_usd: 5,
        },
        { params: projectParams },
      );
      response
        .status(201)
        .body()
        .exists("$.app_id")
        .exists("$.url")
        .has("$.slug", slug)
        .has("$.desired_state", "running");
      appId = response.json<any>().app_id;
    });

    await ctx.step("get and patch read back the same App", async () => {
      const params = { ...projectParams, appId };
      const read = await owner.get("/v1/projects/:projectId/apps/:appId", {
        params,
      });
      read.status(200).body().has("$.app_id", appId);

      const updated = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { name: "Updated ke2e App", idle_timeout_seconds: 420 },
        { params },
      );
      updated
        .status(200)
        .body()
        .has("$.name", "Updated ke2e App")
        .has("$.idle_timeout_seconds", 420);
    });

    await ctx.step(
      "cross-project principal cannot inspect the App",
      async () => {
        const response = await ctx.client
          .as(ctx.P.NONMEMBER)
          .get("/v1/projects/:projectId/apps/:appId", {
            params: { ...projectParams, appId },
          });
        response.status(403);
      },
    );

    await ctx.step(
      "delete is soft and removes the App from reads",
      async () => {
        const params = { ...projectParams, appId };
        const removed = await owner.del("/v1/projects/:projectId/apps/:appId", {
          params,
        });
        removed.status(200).body().has("$.ok", true);
        const read = await owner.get("/v1/projects/:projectId/apps/:appId", {
          params,
        });
        read.status(404);
      },
    );
  },
);

flow(
  "APP-2",
  {
    domain: "apps",
    routes: [
      "POST /v1/projects/:projectId/apps/artifacts",
      "POST /v1/projects/:projectId/apps/artifacts/:artifactId/finalize",
      "POST /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
      "GET /v1/projects/:projectId/apps/:appId/deployments/:deploymentId/logs",
      "POST /v1/projects/:projectId/apps/:appId/rollback",
      "POST /v1/projects/:projectId/apps/:appId/start",
      "POST /v1/projects/:projectId/apps/:appId/stop",
      "GET /v1/projects/:projectId/apps/:appId/access",
      "PATCH /v1/projects/:projectId/apps/:appId/access",
      "POST /v1/projects/:projectId/apps/:appId/access-session",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };

    await ctx.step("enable the apps flag", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(200);
    });

    const slug = ctx.fixtures
      .name("deploy")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63);

    const created = await owner.post(
      "/v1/projects/:projectId/apps",
      { slug, name: "ke2e deployment boundaries" },
      { params: projectParams },
    );
    created.status(201);
    const appId = created.json<any>().app_id as string;
    const appParams = { ...projectParams, appId };
    let artifactId = "";

    await ctx.step("access policy reads back a mode", async () => {
      const response = await owner.get(
        "/v1/projects/:projectId/apps/:appId/access",
        { params: appParams },
      );
      response.status(200).body().exists("$.mode");
    });

    await ctx.step("restricted access requires at least one principal", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "restricted" },
        { params: appParams },
      );
      response.status(400);
    });

    await ctx.step("project-wide access persists and read-back agrees", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "project" },
        { params: appParams },
      );
      response.status(200).body().has("$.mode", "project");
    });

    await ctx.step("member access-session returns a signed URL", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps/:appId/access-session",
        {},
        { params: appParams },
      );
      response.status(200).body().exists("$.url").exists("$.expires_at");
    });

    await ctx.step("register immutable OCI artifact", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps/artifacts",
        { kind: "oci_image", image: "docker.io/library/nginx:alpine" },
        { params: projectParams },
      );
      response
        .status(201)
        .body()
        .exists("$.artifact.artifact_id")
        .has("$.artifact.status", "ready")
        .has("$.upload", null);
      artifactId = response.json<any>().artifact.artifact_id;
    });

    await ctx.step("OCI artifact cannot use archive finalization", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps/artifacts/:artifactId/finalize",
        { sha256: "a".repeat(64), size_bytes: 1 },
        { params: { ...projectParams, artifactId } },
      );
      response.status(409);
    });

    await ctx.step(
      "deployment rejects an image different from its immutable artifact",
      async () => {
        const response = await owner.post(
          "/v1/projects/:projectId/apps/:appId/deployments",
          {
            artifact_id: artifactId,
            source: {
              kind: "oci_image",
              image: "docker.io/library/caddy:alpine",
              command: ["caddy", "file-server"],
              port: 80,
            },
          },
          { params: appParams },
        );
        response.status(400);
      },
    );

    await ctx.step(
      "deployment reads expose empty state and unknown boundaries",
      async () => {
        const list = await owner.get(
          "/v1/projects/:projectId/apps/:appId/deployments",
          {
            params: appParams,
          },
        );
        list.status(200).body().has("$.deployments", []);

        const deploymentParams = { ...appParams, deploymentId: UNKNOWN_ID };
        const detail = await owner.get(
          "/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
          { params: deploymentParams },
        );
        detail.status(404);
        const logs = await owner.get(
          "/v1/projects/:projectId/apps/:appId/deployments/:deploymentId/logs",
          { params: deploymentParams },
        );
        logs.status(404);
      },
    );

    await ctx.step(
      "rollback, start, and stop require a ready active deployment",
      async () => {
        const rollback = await owner.post(
          "/v1/projects/:projectId/apps/:appId/rollback",
          { deployment_id: UNKNOWN_ID },
          { params: appParams },
        );
        rollback.status(409);
        const start = await owner.post(
          "/v1/projects/:projectId/apps/:appId/start",
          {},
          { params: appParams },
        );
        start.status(409);
        const stop = await owner.post(
          "/v1/projects/:projectId/apps/:appId/stop",
          {},
          { params: appParams },
        );
        stop.status(409);
      },
    );
  },
);
