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
      "PATCH /v1/projects/:projectId/features",
      "GET /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId",
      "PATCH /v1/projects/:projectId/apps/:appId",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    let appId = "";

    await ctx.step("clear any apps flag override from a reused project", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: null },
        { params: projectParams },
      );
      response.status(200);
    });

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
      "PATCH /v1/projects/:projectId/features",
      "POST /v1/projects/:projectId/apps",
      "DELETE /v1/projects/:projectId/apps/:appId",
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

    await ctx.step("delete the test App after the boundary checks", async () => {
      const response = await owner.del("/v1/projects/:projectId/apps/:appId", {
        params: appParams,
      });
      response.status(200).body().has("$.ok", true);
    });
  },
);

flow(
  "APP-3",
  {
    domain: "apps",
    routes: [
      "PATCH /v1/projects/:projectId/features",
      "POST /v1/projects/:projectId/apps",
      "PATCH /v1/projects/:projectId/apps/:appId",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    let appId = "";

    await ctx.step("enable the apps flag", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(200);
    });

    const slug = ctx.fixtures
      .name("limits")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63);

    await ctx.step(
      "an App machine may not exceed the session sandbox ceiling",
      async () => {
        // The route used to accept 64 CPU / 512 GB / 2 TB while a session
        // sandbox was capped at 32 / 128 / 500 — and the App was billed for
        // whatever it recorded. Each dimension is refused on its own.
        for (const machine of [
          { cpu: 64 },
          { memory_gb: 512 },
          { disk_gb: 2048 },
        ]) {
          const response = await owner.post(
            "/v1/projects/:projectId/apps",
            { slug, name: "over the ceiling", ...machine },
            { params: projectParams },
          );
          response.status(400);
        }
      },
    );

    await ctx.step("the ceiling itself is accepted", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug, name: "at the ceiling", cpu: 32, memory_gb: 128, disk_gb: 500 },
        { params: projectParams },
      );
      response
        .status(201)
        .body()
        .has("$.machine.cpu", 32)
        .has("$.machine.memory_gb", 128)
        .has("$.machine.disk_gb", 500);
      appId = response.json<any>().app_id;
    });

    await ctx.step("resizing an existing App answers to the same ceiling", async () => {
      const params = { ...projectParams, appId };
      const rejected = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { cpu: 64 },
        { params },
      );
      rejected.status(400);

      const accepted = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { cpu: 2, memory_gb: 4 },
        { params },
      );
      accepted.status(200).body().has("$.machine.cpu", 2).has("$.machine.memory_gb", 4);
    });

    await ctx.step("a machine below the floor is refused too", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { cpu: 0 },
        { params: { ...projectParams, appId } },
      );
      response.status(400);
    });

    await ctx.step("delete the test App", async () => {
      const response = await owner.del("/v1/projects/:projectId/apps/:appId", {
        params: { ...projectParams, appId },
      });
      response.status(200).body().has("$.ok", true);
    });
  },
);

flow(
  "APP-4",
  {
    domain: "apps",
    routes: [
      "PATCH /v1/projects/:projectId/features",
      "GET /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId",
      "PATCH /v1/projects/:projectId/apps/:appId",
      "PATCH /v1/projects/:projectId/apps/:appId/access",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };

    const editor = await team.addMember("member");
    await team.grantProjectRole(project.id, editor.userId!, "member");
    const teammate = ctx.client.as(editor);

    await ctx.step("enable the apps flag", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(200);
    });

    const slug = ctx.fixtures
      .name("scoped")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63);
    let appId = "";

    await ctx.step("a new App is private to the member who created it", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug, name: "ke2e scoped App" },
        { params: projectParams },
      );
      response.status(201).body().has("$.access_mode", "private");
      appId = response.json<any>().app_id;
    });

    await ctx.step(
      "a teammate does not see, read, or resize someone else's private App",
      async () => {
        // access_mode governed PUBLIC traffic only, so a private App was still
        // listed, renamed, resized and redeployed by the whole project. 404,
        // not 403 — a teammate must not learn the App exists from the status.
        const list = await teammate.get("/v1/projects/:projectId/apps", {
          params: projectParams,
        });
        list.status(200);
        const visible = list.json<any>().apps.map((app: any) => app.app_id);
        if (visible.includes(appId)) {
          throw new Error(`private App ${appId} was listed to a teammate`);
        }

        const read = await teammate.get("/v1/projects/:projectId/apps/:appId", {
          params: { ...projectParams, appId },
        });
        read.status(404);

        // A project member holds `project.app.read` but not `project.app.write`,
        // so EVERY App PATCH is 403 for them — visible or not — which discloses
        // nothing about this App's existence. (Before the editor role was
        // removed, the teammate here was an editor with write, and the privacy
        // check answered 404 first.)
        const resize = await teammate.patch(
          "/v1/projects/:projectId/apps/:appId",
          { cpu: 4 },
          { params: { ...projectParams, appId } },
        );
        resize.status(403);
      },
    );

    await ctx.step("sharing it project-wide lets the teammate operate it", async () => {
      const shared = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "project" },
        { params: { ...projectParams, appId } },
      );
      shared.status(200).body().has("$.mode", "project");

      const read = await teammate.get("/v1/projects/:projectId/apps/:appId", {
        params: { ...projectParams, appId },
      });
      read.status(200).body().has("$.app_id", appId);

      const list = await teammate.get("/v1/projects/:projectId/apps", {
        params: projectParams,
      });
      list.status(200);
      const visible = list.json<any>().apps.map((app: any) => app.app_id);
      if (!visible.includes(appId)) {
        throw new Error(`project-wide App ${appId} was hidden from a teammate`);
      }
    });

    await ctx.step(
      "restricting it to a named teammate keeps that teammate in",
      async () => {
        const restricted = await owner.patch(
          "/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", member_ids: [editor.userId] },
          { params: { ...projectParams, appId } },
        );
        restricted.status(200).body().has("$.mode", "restricted");

        const read = await teammate.get("/v1/projects/:projectId/apps/:appId", {
          params: { ...projectParams, appId },
        });
        read.status(200).body().has("$.app_id", appId);
      },
    );

    await ctx.step(
      "restricting it to nobody else puts the teammate back out",
      async () => {
        const owned = await owner.patch(
          "/v1/projects/:projectId/apps/:appId/access",
          { mode: "private" },
          { params: { ...projectParams, appId } },
        );
        owned.status(200).body().has("$.mode", "private");

        const read = await teammate.get("/v1/projects/:projectId/apps/:appId", {
          params: { ...projectParams, appId },
        });
        read.status(404);
      },
    );

    await ctx.step("a password protects the hostname, not the team", async () => {
      // A password is a PUBLIC-traffic control. Treating it as a privacy mode
      // would hide the App from the teammates who operate it.
      const secured = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "password", password: "ke2e-app-password" },
        { params: { ...projectParams, appId } },
      );
      secured.status(200).body().has("$.mode", "password");

      const read = await teammate.get("/v1/projects/:projectId/apps/:appId", {
        params: { ...projectParams, appId },
      });
      read.status(200).body().has("$.app_id", appId);
    });

    await ctx.step("a non-member still gets nothing", async () => {
      const response = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/apps", { params: projectParams });
      response.status(403);
    });

    await ctx.step("delete the test App", async () => {
      const response = await owner.del("/v1/projects/:projectId/apps/:appId", {
        params: { ...projectParams, appId },
      });
      response.status(200).body().has("$.ok", true);
    });
  },
);
