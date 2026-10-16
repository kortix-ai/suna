/**
 * Kortix Apps — project-owned App CRUD, artifact registration, and
 * deployment lifecycle boundaries, the App viewer token, and deleting an App
 * or one deployment together with its provider images, and the machine, scale,
 * exec and volume routes. Maps to spec section 28 (APP-1..8,
 * APP-11, APP-13; APP-9, APP-10 and APP-12 live in apps-tokens.flow.ts).
 */
import { flow } from "../core/flow";
import type { Client } from "../core/client";
import type { Principal } from "../core/types";
import { CliSandbox } from "../fixtures/cli";
import { withDb } from "../fixtures/chat";
import { waitFor } from "../core/poll";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

flow(
  "APP-1",
  {
    domain: "apps",
    routes: [
      "PATCH /v1/projects/:projectId/features",
      "PUT /v1/admin/api/projects/:id/features",
      "GET /v1/projects/:projectId",
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

    await ctx.step("a project with no flag override reaches Apps: list answers 200", async () => {
      // Apps went GA (2026-10-14, spec §28): there is no `apps` flag, so a
      // project that never opted in can list and create Apps. APP-2 covers
      // persisted `apps: false`, including an accepted deployment.
      const response = await owner.get("/v1/projects/:projectId/apps", {
        params: projectParams,
      });
      response.status(200).body().has("$.apps", []);
    });

    await ctx.step("the graduated apps key is unknown: /features → 400, no catalog row", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(400);
      response.body().has("$.error", "Unknown feature flag 'apps'");
      const read = await owner.get("/v1/projects/:projectId", { params: projectParams });
      read.status(200);
      const rows = (read.json() as { experimental_features: Array<{ key: string }> })
        .experimental_features;
      if (rows.some((f) => f.key === "apps")) {
        throw new Error(`the catalog still lists apps: ${JSON.stringify(rows)}`);
      }
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

    await ctx.step("create returns stable App policy and URL, its 24/7 cost and no budget; a budget sent by an old client is ignored", async () => {
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
          always_on: true,
        },
        { params: projectParams },
      );
      response
        .status(201)
        .body()
        .exists("$.app_id")
        .exists("$.url")
        .has("$.slug", slug)
        .has("$.desired_state", "running")
        .has("$.always_on", true)
        .has("$.estimated_monthly_usd", 39.95)
        .has("$.warnings", [])
        // One primitive: clients branch on capabilities. No labels, services or uses until set.
        .has("$.capabilities", ["deployments", "rollback", "preview", "member_tokens"])
        .has("$.labels", [])
        .has("$.services", [])
        .has("$.uses", []);
      appId = response.json<any>().app_id;
      for (const retired of ["kind", "instance"]) {
        if (retired in response.json<any>()) throw new Error(`an App carries retired field ${retired}: ${response.text()}`);
      }
      if ("monthly_budget_usd" in response.json<any>()) throw new Error(`an App carries a budget: ${response.text()}`);

      // Apps have no budget: an on-demand App sent with one by an old client is created without one.
      const legacy = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug: `${slug.slice(0, 55)}-budget`, name: "ke2e App", always_on: false, monthly_budget_usd: 5 },
        { params: projectParams },
      );
      legacy.status(201).body().has("$.always_on", false);
      if ("monthly_budget_usd" in legacy.json<any>()) throw new Error(`an App carries a budget: ${legacy.text()}`);
      (await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId: legacy.json<any>().app_id } })).status(200);
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
        .has("$.idle_timeout_seconds", 420)
        .has("$.warnings", []);

      // The run mode switches both ways; a budget an old client sends is ignored, never refused.
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { always_on: false, monthly_budget_usd: 12 }, { params }))
        .status(200).body().has("$.always_on", false).has("$.warnings", []);
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { always_on: true }, { params }))
        .status(200).body().has("$.always_on", true);
      const reread = await owner.get("/v1/projects/:projectId/apps/:appId", { params });
      reread.status(200).body().has("$.always_on", true).has("$.estimated_monthly_usd", 39.95);
      if ("monthly_budget_usd" in reread.json<any>()) throw new Error(`an App carries a budget: ${reread.text()}`);

      // `uses` names live Apps of the project by slug: an unknown one → 400 app_not_found, a malformed one → 400.
      const unknown = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { uses: ["no-such-app"] },
        { params },
      );
      unknown.status(400).body().has("$.code", "app_not_found").has("$.slugs", ["no-such-app"]);
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { uses: ["Not A Slug"] }, { params })).status(400);
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { uses: [] }, { params }))
        .status(200)
        .body()
        .has("$.uses", []);
    });

    await ctx.step("display says where Kortix shows the App: patched whole, read back, {} restores the defaults, an unknown key is refused", async () => {
      const params = { ...projectParams, appId };
      (await owner.get("/v1/projects/:projectId/apps/:appId", { params })).status(200).body().has("$.display", {});
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { display: { parent: "crm-data", preview: "none", listed: false } }, { params }))
        .status(200).body().has("$.display", { parent: "crm-data", preview: "none", listed: false });
      (await owner.get("/v1/projects/:projectId/apps/:appId", { params }))
        .status(200).body().has("$.display", { parent: "crm-data", preview: "none", listed: false });
      for (const bad of [{ hidden: true }, { preview: "icon" }, { parent: "Not A Slug" }]) {
        (await owner.patch("/v1/projects/:projectId/apps/:appId", { display: bad }, { params })).status(400);
      }
      (await owner.patch("/v1/projects/:projectId/apps/:appId", { display: {} }, { params })).status(200).body().has("$.display", {});
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
      "GET /v1/projects/:projectId/apps",
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

    await ctx.step("persist legacy apps:false directly; Apps still lists with 200", async () => {
      await withDb(ctx, async (db) => {
        const seeded = await db.query(
          `UPDATE kortix.projects
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'experimental', COALESCE(metadata->'experimental', '{}'::jsonb) || '{"apps":false}'::jsonb)
           WHERE project_id = $1
           RETURNING metadata->'experimental'->'apps' AS apps`,
          [project.id],
        );
        if (seeded.rows.length !== 1 || seeded.rows[0].apps !== false) {
          throw new Error("legacy apps:false was not persisted");
        }
      });
      (await owner.get("/v1/projects/:projectId/apps", { params: projectParams }))
        .status(200).body().has("$.apps", []);
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

    await ctx.step("legacy apps:false permits an immutable OCI deployment: 202 queued, version 1, readable by ID", async () => {
      const response = await owner.post(
        "/v1/projects/:projectId/apps/:appId/deployments",
        {
          artifact_id: artifactId,
          source: {
            kind: "oci_image",
            image: "docker.io/library/nginx:alpine",
            command: ["nginx", "-g", "daemon off;"],
            port: 80,
          },
        },
        { params: appParams },
      );
      response.status(202).body().has("$.status", "queued").has("$.version", 1).exists("$.deployment_id");
      const deploymentBody = response.json<unknown>();
      if (typeof deploymentBody !== "object" || deploymentBody === null ||
          !("deployment_id" in deploymentBody) || typeof deploymentBody.deployment_id !== "string") {
        throw new Error("accepted deployment did not return a deployment ID");
      }
      const deploymentId = deploymentBody.deployment_id;
      (await owner.get("/v1/projects/:projectId/apps/:appId/deployments/:deploymentId", {
        params: { ...appParams, deploymentId },
      })).status(200).body().has("$.deployment.deployment_id", deploymentId);
    });

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
      "PUT /v1/admin/api/projects/:id/features",
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
      "PUT /v1/admin/api/projects/:id/features",
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
      "an App restricted to the owner alone is absent from the teammate's list and 404 on get; the owner lists both, every card openable",
      async () => {
        const created = await owner.post(
          "/v1/projects/:projectId/apps",
          { slug: `${slug.slice(0, 55)}-owner`, name: "ke2e owner-only App" },
          { params: projectParams },
        );
        created.status(201);
        const ownerOnly = created.json<any>().app_id as string;
        (await owner.patch(
          "/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", member_ids: [ctx.P.OWNER.userId] },
          { params: { ...projectParams, appId: ownerOnly } },
        )).status(200).body().has("$.mode", "restricted");

        const teammateList = await teammate.get("/v1/projects/:projectId/apps", { params: projectParams });
        teammateList.status(200);
        const teammateApps = teammateList.json<any>().apps as Array<{ app_id: string; viewer_can_access: boolean }>;
        const teammateIds = teammateApps.map((app) => app.app_id);
        if (teammateIds.includes(ownerOnly)) throw new Error(`owner-only App ${ownerOnly} was listed to a teammate`);
        if (!teammateIds.includes(appId)) throw new Error(`App ${appId} restricted to the teammate was hidden from them`);
        if (teammateApps.some((app) => app.viewer_can_access !== true)) {
          throw new Error(`the teammate's list holds an App they cannot open: ${JSON.stringify(teammateApps)}`);
        }
        (await teammate.get("/v1/projects/:projectId/apps/:appId", {
          params: { ...projectParams, appId: ownerOnly },
        })).status(404);

        const ownerList = await owner.get("/v1/projects/:projectId/apps", { params: projectParams });
        ownerList.status(200);
        const ownerIds = (ownerList.json<any>().apps as Array<{ app_id: string }>).map((app) => app.app_id);
        if (!ownerIds.includes(ownerOnly) || !ownerIds.includes(appId)) {
          throw new Error(`the owner does not list every App: ${JSON.stringify(ownerIds)}`);
        }
        (await owner.del("/v1/projects/:projectId/apps/:appId", {
          params: { ...projectParams, appId: ownerOnly },
        })).status(200);
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

flow(
  "APP-13",
  {
    domain: "apps",
    timeoutMs: 240_000,
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/accounts/:accountId/iam/groups",
      "POST /v1/accounts/:accountId/iam/groups/:groupId/members",
      "POST /v1/projects/:projectId/apps",
      "PATCH /v1/projects/:projectId/apps/:appId/access",
      "GET /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId",
      "POST /v1/projects/:projectId/apps/:appId/access-session",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    const accountParams = { accountId: team.id };

    // The reported failure (2026-10-14, #kortix-triage): an App admitting two
    // groups refused a member of BOTH, while the same App restricted to one
    // group loaded — read as AND semantics. Under OR, either membership admits
    // and widening the allow-list can never lock a member out, so this flow
    // signs in one member per position and proves the verdicts at the real
    // surface: list, read and the access session that opens the App.
    const qrOnly = await team.addMember("member");
    const absOnly = await team.addMember("member");
    const bothMember = await team.addMember("member");
    const neither = await team.addMember("member");
    const noRole = await team.addMember("member");
    const userId = (member: Principal) => {
      if (!member.userId) throw new Error("group fixture member has no user id");
      return member.userId;
    };
    await team.grantProjectRole(project.id, userId(qrOnly), "member");
    await team.grantProjectRole(project.id, userId(absOnly), "member");
    await team.grantProjectRole(project.id, userId(bothMember), "member");
    await team.grantProjectRole(project.id, userId(neither), "member");

    const asQrOnly = ctx.client.as(qrOnly);
    const asAbsOnly = ctx.client.as(absOnly);
    const asBoth = ctx.client.as(bothMember);

    const group = async (slug: string, members: Principal[]) => {
      const created = await owner.post(
        "/v1/accounts/:accountId/iam/groups",
        { name: ctx.fixtures.name(slug) },
        { params: accountParams },
      );
      const groupId = created.status(201).json<{ group_id: string }>().group_id;
      (
        await owner.post(
          "/v1/accounts/:accountId/iam/groups/:groupId/members",
          { userIds: members.map(userId) },
          { params: { ...accountParams, groupId } },
        )
      ).status(200);
      return groupId;
    };

    const slug = ctx.fixtures
      .name("group-scoped")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63);
    let appId = "";
    let qr = "";
    let abs = "";

    const canOpen = async (client: Client) => {
      const read = await client.get("/v1/projects/:projectId/apps/:appId", {
        params: { ...params, appId },
      });
      const listed = await client.get("/v1/projects/:projectId/apps", { params });
      const ids = listed.status(200).json<{ apps: Array<{ app_id: string }> }>().apps.map((a) => a.app_id);
      const session = await client.post(
        "/v1/projects/:projectId/apps/:appId/access-session",
        {},
        { params: { ...params, appId } },
      );
      return { read, listedId: ids.includes(appId), session };
    };

    await ctx.step(
      "setup: two allowed groups — one member in each, one in both, one in neither, and a fifth in the FIRST group with no project role — and an App restricted to the two groups",
      async () => {
        // The fifth member sits INSIDE an allowed group: the pin below is that
        // group membership never widens the project, which only bites for a
        // member the App itself would admit.
        qr = await group("grp-qr", [qrOnly, bothMember, noRole]);
        abs = await group("grp-abs", [absOnly, bothMember]);
        // Apps is GA (2026-10-14): no flag setup — a fresh project lists and
        // creates Apps with no override (APP-2 pins that).
        const created = await owner.post(
          "/v1/projects/:projectId/apps",
          { slug, name: "ke2e group App" },
          { params },
        );
        created.status(201);
        appId = created.json<{ app_id: string }>().app_id;
        const restricted = await owner.patch(
          "/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", group_ids: [qr, abs] },
          { params: { ...params, appId } },
        );
        restricted.status(200).body().has("$.mode", "restricted");
      },
    );

    await ctx.step("a member of the first allowed group can open the App", async () => {
      const { read, listedId, session } = await canOpen(asQrOnly);
      read.status(200).body().has("$.app_id", appId);
      if (!listedId) throw new Error("a member of the first allowed group does not see the App");
      session.status(200).body().exists("$.url");
    });

    await ctx.step("a member of the second allowed group can open the App — EITHER group suffices", async () => {
      const { read, listedId, session } = await canOpen(asAbsOnly);
      read.status(200).body().has("$.app_id", appId);
      if (!listedId) throw new Error("a member of the second allowed group does not see the App");
      session.status(200).body().exists("$.url");
    });

    await ctx.step("a member of BOTH allowed groups can open the App (the reported failure)", async () => {
      const { read, listedId, session } = await canOpen(asBoth);
      read.status(200).body().has("$.app_id", appId);
      if (!listedId) throw new Error("a member of both allowed groups does not see the App");
      session.status(200).body().exists("$.url");
    });

    await ctx.step("a member of neither allowed group stays denied", async () => {
      // 404, never 403: the status must not disclose a teammate's restricted App.
      const read = await ctx.client.as(neither).get("/v1/projects/:projectId/apps/:appId", {
        params: { ...params, appId },
      });
      read.status(404);
      const listed = await ctx.client.as(neither).get("/v1/projects/:projectId/apps", { params });
      const ids = listed.status(200).json<{ apps: Array<{ app_id: string }> }>().apps.map((a) => a.app_id);
      if (ids.includes(appId)) throw new Error("a member of neither allowed group sees the App");
      (
        await ctx.client.as(neither).post(
          "/v1/projects/:projectId/apps/:appId/access-session",
          {},
          { params: { ...params, appId } },
        )
      ).status(404);
    });

    await ctx.step("group membership does not stand in for project access", async () => {
      // An account member INSIDE an allowed group but with no role on the
      // project still gets nothing: the App allow-list narrows PROJECT
      // members, it never widens the project itself. The contrast with the
      // neither-member step (a project member without app access gets a 200
      // list with the App filtered out) shows this 403 is the project gate
      // firing — group membership did not buy project access.
      const listed = await ctx.client.as(noRole).get("/v1/projects/:projectId/apps", { params });
      listed.status(403).body().has("$.code", "no_project_membership").has("$.action", "project.read");
    });

    await ctx.step("narrowing the policy to one group keeps that group's members in", async () => {
      const narrowed = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "restricted", group_ids: [abs] },
        { params: { ...params, appId } },
      );
      narrowed.status(200).body().has("$.mode", "restricted");
      const { session } = await canOpen(asBoth);
      session.status(200).body().exists("$.url");
      // The dropped group legitimately loses access: the policy now means it.
      (
        await asQrOnly.post(
          "/v1/projects/:projectId/apps/:appId/access-session",
          {},
          { params: { ...params, appId } },
        )
      ).status(404);
    });

    await ctx.step("widening back to both groups restores the dropped group's members", async () => {
      const widened = await owner.patch(
        "/v1/projects/:projectId/apps/:appId/access",
        { mode: "restricted", group_ids: [qr, abs] },
        { params: { ...params, appId } },
      );
      widened.status(200).body().has("$.mode", "restricted");
      const { session } = await canOpen(asQrOnly);
      session.status(200).body().exists("$.url");
      const bothAgain = await canOpen(asBoth);
      bothAgain.session.status(200).body().exists("$.url");
    });

    await ctx.step("delete the test App", async () => {
      const response = await owner.del("/v1/projects/:projectId/apps/:appId", {
        params: { ...params, appId },
      });
      response.status(200).body().has("$.ok", true);
    });
  },
);

flow(
  "APP-5",
  {
    domain: "apps",
    tags: ["deployed"],
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "GET /v1/apps/edge/tls-check",
      "GET /v1/edge/tls-check",
    ],
  },
  async (ctx) => {
    // The on-demand-TLS gate a self-host reverse proxy calls before it issues a
    // certificate for an App hostname. Unauthenticated by design (Caddy cannot
    // present a bearer token), so the contract that matters is: 200 ONLY for a
    // real App host, and no certificate for anything else.
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const projectParams = { projectId: project.id };
    let appId = "";
    let appHost = "";

    await ctx.step("create an App and take its public hostname", async () => {
      const slug = ctx.fixtures
        .name("edge")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 63);
      const response = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug, name: "ke2e edge App" },
        { params: projectParams },
      );
      response.status(201).body().exists("$.url");
      const created = response.json<any>();
      appId = created.app_id;
      appHost = new URL(created.url as string).hostname;
    });

    await ctx.step("the App's own hostname is allowed to get a certificate", async () => {
      const response = await anon.get("/v1/apps/edge/tls-check", {
        query: { domain: appHost },
      });
      response.status(200).body().has("$.ok", true);

      const canonical = await anon.get("/v1/edge/tls-check", {
        query: { domain: appHost },
      });
      canonical.status(200).body().has("$.ok", true);
    });

    await ctx.step("a hostname that is not an App host is refused", async () => {
      // Not the App base domain at all, and the bare route with no domain.
      const foreign = await anon.get("/v1/apps/edge/tls-check", {
        query: { domain: "totally-unrelated.example.com" },
      });
      foreign.status(403);

      const missing = await anon.get("/v1/apps/edge/tls-check");
      missing.status(403);
    });

    await ctx.step("an App-shaped hostname for no such App is refused", async () => {
      // Same shape, different (nonexistent) immutable route key. On a real
      // domain that is a 404 — App-shaped but no App row, so no certificate.
      // A local `*.apps.localhost` box never issues certificates and short-
      // circuits the DB round-trip, so there it answers 200 by design; the
      // 404 branch itself is pinned in apps/api/src/apps/edge.test.ts.
      const local = appHost.endsWith(".apps.localhost");
      const unknownHost = appHost.replace(/[0-9a-f]{16}/, "0123456789abcdef");
      if (unknownHost === appHost) {
        throw new Error(`could not derive an unknown App host from ${appHost}`);
      }
      const response = await anon.get("/v1/apps/edge/tls-check", {
        query: { domain: unknownHost },
      });
      response.status(local ? 200 : 404);
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
  "APP-6",
  {
    domain: "apps",
    requires: ["appHost"],
    timeoutMs: 180_000,
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "PATCH /v1/projects/:projectId/apps/:appId/access",
      "POST /v1/projects/:projectId/apps/:appId/access-session",
      "POST /v1/projects/:projectId/sessions",
      "GET /v1/accounts/me",
      "GET /v1/projects/:projectId",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    const viewerPrincipal = await team.addMember("member");
    await team.grantProjectRole(project.id, viewerPrincipal.userId!, "member");
    const viewer = ctx.client.as(viewerPrincipal);
    const slug = ctx.fixtures.name("viewer").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    const apiOrigin = ctx.env.apiUrl.replace(/\/v1$/, "");
    let appId = "";
    let appHost = "";

    // The gate, at the App's own hostname. Local Apps answer under
    // `<route-key>.apps.localhost`: the Host names the App (an unsigned
    // `x-kortix-app-host` claim is never trusted).
    const gate = async (pathAndQuery: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${apiOrigin}${pathAndQuery}`, {
        headers: { accept: "application/json", host: `${appHost}:${new URL(apiOrigin).port}`, ...headers },
        redirect: "manual",
      });
      const text = await response.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, headers: response.headers, body, text };
    };
    // What a browser does with an access link: redeem it, keep the cookie.
    const signIn = async (): Promise<string> => {
      const session = await viewer.post(
        "/v1/projects/:projectId/apps/:appId/access-session",
        {},
        { params: { ...projectParams, appId } },
      );
      session.status(200);
      const link = new URL(session.json<any>().url);
      const redeemed = await gate(`${link.pathname}${link.search}`);
      const cookie = redeemed.headers.get("set-cookie")?.split(";")[0] ?? "";
      if (redeemed.status !== 303 || !cookie) {
        throw new Error(`access link did not sign in: ${redeemed.status} ${redeemed.text.slice(0, 200)}`);
      }
      return cookie;
    };
    const viewerToken = async (cookie: string) => {
      const r = await gate("/_kortix/viewer", { cookie });
      if (r.status !== 200) throw new Error(`/_kortix/viewer: ${r.status} ${r.text.slice(0, 200)}`);
      return r.body as { user_id: string; scopes: string[]; access_token: string | null; expires_at: string | null };
    };
    const asToken = (token: string) => ctx.client.withBearer(token, "app-viewer-token");

    try {
      await ctx.step("create an App restricted to the viewer that acts as them (api scope)", async () => {
        const created = await owner.post("/v1/projects/:projectId/apps", { slug, name: "ke2e viewer token" },
          { params: projectParams });
        created.status(201);
        appId = created.json<any>().app_id;
        appHost = new URL(created.json<any>().url).hostname;
        const access = await owner.patch("/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", member_ids: [viewerPrincipal.userId], viewer_token_scope: "api" },
          { params: { ...projectParams, appId } });
        access.status(200).body().has("$.viewer_token_scope", "api");
      });

      await ctx.step("an anonymous visitor gets no viewer: 401 app_auth_required", async () => {
        const r = await gate("/_kortix/viewer");
        if (r.status !== 401 || r.body?.code !== "app_auth_required") {
          throw new Error(`expected 401 app_auth_required, got ${r.status} ${r.text.slice(0, 200)}`);
        }
      });

      let firstToken = "";
      await ctx.step("a viewer signed in by an access link receives a one-hour kortix-scoped token", async () => {
        const session = await viewerToken(await signIn());
        if (session.user_id !== viewerPrincipal.userId) throw new Error(`viewer is ${session.user_id}`);
        if (JSON.stringify(session.scopes) !== JSON.stringify(["profile", "email", "kortix"])) {
          throw new Error(`scopes ${JSON.stringify(session.scopes)}`);
        }
        if (!session.access_token?.startsWith("kortix_oat_")) throw new Error("no kortix_oat_ token");
        const ttlMs = Date.parse(session.expires_at ?? "") - Date.now();
        if (!(ttlMs > 55 * 60_000 && ttlMs <= 60 * 60_000)) throw new Error(`token lifetime ${ttlMs} ms`);
        firstToken = session.access_token;
      });

      await ctx.step("the viewer's own role is the ceiling: as a project member with no agent grant, 403 no_agent_access", async () => {
        const refused = await asToken(firstToken).post("/v1/projects/:projectId/sessions",
          { agent_name: "kortix", metadata: { repository_access: false, workspace_mode: "runtime" } }, { params: projectParams });
        refused.status(403).body().has("$.code", "no_agent_access");
      });

      await ctx.step("the token acts as the viewer: /v1/accounts/me answers as them, not as the App's author", async () => {
        const me = await asToken(firstToken).get("/v1/accounts/me");
        me.status(200).body()
          .has("$.user_id", viewerPrincipal.userId)
          .has("$.token_context.auth_type", "oauth");
      });

      await ctx.step("an access-policy save revokes the token; the next sign-in hands out a new one that works", async () => {
        (await owner.patch("/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", member_ids: [viewerPrincipal.userId], viewer_token_scope: "api" },
          { params: { ...projectParams, appId } })).status(200);
        (await asToken(firstToken).get("/v1/projects/:projectId", { params: projectParams })).status(401);
        const next = await viewerToken(await signIn());
        if (!next.access_token || next.access_token === firstToken) {
          throw new Error("the gate handed out the revoked token again");
        }
        (await asToken(next.access_token).get("/v1/projects/:projectId", { params: projectParams })).status(200);
      });

      await ctx.step("a browser App reaches the API on its own origin: /_kortix/api/v1/accounts/me answers as the viewer; the App's cookie never reaches the API; a cross-site call gets 403", async () => {
        const cookie = await signIn();
        const me = await gate("/_kortix/api/v1/accounts/me", { cookie, "sec-fetch-site": "same-origin" });
        if (me.status !== 200 || me.body?.user_id !== viewerPrincipal.userId || me.body?.token_context?.auth_type !== "oauth") {
          throw new Error(`expected 200 as the viewer through the gate, got ${me.status} ${me.text.slice(0, 300)}`);
        }
        if (me.headers.get("set-cookie")) throw new Error("the App API path set a cookie on the App origin");
        const read = await gate(`/_kortix/api/v1/projects/${project.id}`, { cookie, "sec-fetch-site": "same-origin" });
        if (read.status !== 200 || read.body?.project_id !== project.id) {
          throw new Error(`expected the viewer's project through the gate, got ${read.status} ${read.text.slice(0, 300)}`);
        }
        const crossSite = await gate("/_kortix/api/v1/accounts/me", { cookie, "sec-fetch-site": "cross-site" });
        if (crossSite.status !== 403 || crossSite.body?.error !== "cross_site_request") {
          throw new Error(`expected 403 cross_site_request, got ${crossSite.status} ${crossSite.text.slice(0, 200)}`);
        }
        const oauth = await gate("/_kortix/api/v1/oauth/clients", { cookie, "sec-fetch-site": "same-origin" });
        if (oauth.status !== 404) throw new Error(`expected 404 for /v1/oauth through the gate, got ${oauth.status}`);
      });

      await ctx.step("kortix apps access --viewer identity switches the scope and keeps mode and members", async () => {
        const cli = new CliSandbox("app6");
        try {
          const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-app6") });
          const login = await cli.login(pat, { noProject: true, account: project.accountId });
          if (login.exitCode !== 0) throw new Error(`kortix login: ${login.stderr}`);
          const bad = await cli.run(["apps", "access", appId, "--viewer", "everything", "--project", project.id, "--json"]);
          if (bad.exitCode === 0 || !/--viewer must be off, identity, or api/.test(bad.stderr + bad.stdout)) {
            throw new Error(`an invalid --viewer was accepted: ${bad.exitCode} ${bad.stderr}`);
          }
          const set = await cli.run(["apps", "access", appId, "--viewer", "identity", "--project", project.id, "--json"]);
          if (set.exitCode !== 0) throw new Error(`kortix apps access --viewer: ${set.exitCode} ${set.stderr}`);
          const access = JSON.parse(set.stdout).access;
          if (access.viewer_token_scope !== "identity" || access.mode !== "restricted"
            || JSON.stringify(access.member_ids) !== JSON.stringify([viewerPrincipal.userId])) {
            throw new Error(`unexpected access after --viewer identity: ${JSON.stringify(access)}`);
          }
        } finally {
          cli.dispose();
        }
      });

      await ctx.step("an identity-scoped App's token names the viewer but opens no project route (403); its /_kortix/api path answers 403 viewer_api_disabled", async () => {
        const session = await viewerToken(await signIn());
        if (JSON.stringify(session.scopes) !== JSON.stringify(["profile", "email"]) || !session.access_token) {
          throw new Error(`identity scope returned ${JSON.stringify(session.scopes)}`);
        }
        (await asToken(session.access_token).get("/v1/projects/:projectId", { params: projectParams })).status(403);
        const proxied = await gate("/_kortix/api/v1/accounts/me", { cookie: await signIn(), "sec-fetch-site": "same-origin" });
        if (proxied.status !== 403 || proxied.body?.error !== "viewer_api_disabled") {
          throw new Error(`expected 403 viewer_api_disabled through the gate, got ${proxied.status} ${proxied.text.slice(0, 200)}`);
        }
      });

      await ctx.step("an App that shares nothing answers /_kortix/viewer with 404 viewer_disabled", async () => {
        (await owner.patch("/v1/projects/:projectId/apps/:appId/access",
          { mode: "restricted", member_ids: [viewerPrincipal.userId], viewer_token_scope: "off" },
          { params: { ...projectParams, appId } })).status(200);
        const r = await gate("/_kortix/viewer", { cookie: await signIn() });
        if (r.status !== 404 || r.body?.error !== "viewer_disabled") {
          throw new Error(`expected 404 viewer_disabled, got ${r.status} ${r.text.slice(0, 200)}`);
        }
      });
    } finally {
      if (appId) {
        await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } }).catch(() => {});
      }
    }
  },
);

flow(
  "APP-7",
  {
    domain: "apps",
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps/artifacts",
      "POST /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
      "DELETE /v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "GET /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    const IN_PROGRESS = ["queued", "validating", "building", "provisioning", "checking"];

    const slug = ctx.fixtures
      .name("images")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63);
    let appId = "";
    let deploymentId = "";
    const deploymentParams = () => ({ ...projectParams, appId, deploymentId });
    const cli = new CliSandbox("app7");
    try {
      await ctx.step("create an App and deploy an immutable OCI artifact", async () => {
        const created = await owner.post(
          "/v1/projects/:projectId/apps",
          { slug, name: "ke2e image release" },
          { params: projectParams },
        );
        created.status(201);
        appId = created.json<any>().app_id;
        const artifact = await owner.post(
          "/v1/projects/:projectId/apps/artifacts",
          { kind: "oci_image", image: "docker.io/library/nginx:alpine" },
          { params: projectParams },
        );
        artifact.status(201);
        const deployment = await owner.post(
          "/v1/projects/:projectId/apps/:appId/deployments",
          {
            artifact_id: artifact.json<any>().artifact.artifact_id,
            source: {
              kind: "oci_image",
              image: "docker.io/library/nginx:alpine",
              command: ["nginx", "-g", "daemon off;"],
              port: 80,
            },
          },
          { params: { ...projectParams, appId } },
        );
        deployment.status(202).body().has("$.status", "queued").has("$.version", 1);
        deploymentId = deployment.json<any>().deployment_id;
      });

      await ctx.step("a deployment still in progress is refused with 409 deployment_in_progress", async () => {
        const refused = await owner.del(
          "/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
          { params: deploymentParams() },
        );
        refused.status(409).body().has("$.code", "deployment_in_progress");
        const status = refused.json<any>().status;
        if (!IN_PROGRESS.includes(status)) throw new Error(`409 named a finished status: ${status}`);
      });

      await ctx.step("an unknown deployment answers 404; a cross-project principal gets 403", async () => {
        (await owner.del(
          "/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
          { params: { ...projectParams, appId, deploymentId: UNKNOWN_ID } },
        )).status(404);
        (await ctx.client.as(ctx.P.NONMEMBER).del(
          "/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
          { params: deploymentParams() },
        )).status(403);
      });

      await ctx.step("kortix apps delete --deployment requires --yes, names the deployments that exist, and relays the 409", async () => {
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-app7") });
        const login = await cli.login(pat, { noProject: true, account: project.accountId });
        if (login.exitCode !== 0) throw new Error(`kortix login: ${login.stderr}`);
        const unconfirmed = await cli.run(["apps", "delete", slug, "--deployment", "v1", "--project", project.id]);
        if (unconfirmed.exitCode === 0 || !/deleting a deployment is destructive; pass --yes/.test(unconfirmed.stderr + unconfirmed.stdout)) {
          throw new Error(`delete --deployment ran without --yes: ${unconfirmed.exitCode} ${unconfirmed.stderr}`);
        }
        const unknown = await cli.run(["apps", "delete", slug, "--deployment", "v9", "--yes", "--project", project.id]);
        if (unknown.exitCode === 0 || !/Deployment v9 not found \(deployments: v1\)/.test(unknown.stderr + unknown.stdout)) {
          throw new Error(`unknown deployment was not named: ${unknown.exitCode} ${unknown.stderr} ${unknown.stdout}`);
        }
        // v1 is still building on the local stack. On a deployed target the
        // build can finish first, and the API then refuses for the other
        // reason: v1 serves live traffic. Either 409 must reach the user.
        const inProgress = await cli.run(["apps", "delete", slug, "--deployment", "v1", "--yes", "--project", project.id]);
        if (inProgress.exitCode === 0 || !/still in progress \(status: [a-z]+\)|serves live traffic/.test(inProgress.stderr + inProgress.stdout)) {
          throw new Error(`in-progress delete was not refused: ${inProgress.exitCode} ${inProgress.stderr} ${inProgress.stdout}`);
        }
        const list = await owner.get(
          "/v1/projects/:projectId/apps/:appId/deployments",
          { params: { ...projectParams, appId } },
        );
        list.status(200).body().has("$.deployments[0].deployment_id", deploymentId);
      });

      await ctx.step("kortix apps delete --yes --json deletes the App during its build and reports the image release", async () => {
        const deleted = await cli.run(["apps", "delete", slug, "--yes", "--json", "--project", project.id]);
        if (deleted.exitCode !== 0) throw new Error(`kortix apps delete: ${deleted.exitCode} ${deleted.stderr}`);
        const body = JSON.parse(deleted.stdout);
        // The App owns at most one image here. On the local stack the build is
        // still running, so it is pending (0 or 1, depending on whether the
        // worker recorded the build provider yet). On a deployed target the
        // build can finish first, and then the image is released instead.
        const released = body.images?.released;
        const pending = body.images?.pending;
        if (body.ok !== true || body.app_id !== appId || body.slug !== slug
          || ![0, 1].includes(released) || ![0, 1].includes(pending) || released + pending > 1) {
          throw new Error(`unexpected delete output: ${deleted.stdout}`);
        }
        (await owner.get("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } })).status(404);
        (await owner.get(
          "/v1/projects/:projectId/apps/:appId/deployments",
          { params: { ...projectParams, appId } },
        )).status(404);
        appId = "";
      });
    } finally {
      cli.dispose();
      if (appId) {
        await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } }).catch(() => {});
      }
    }
  },
);

flow(
  "APP-8",
  {
    domain: "apps",
    requires: ["appHost"],
    timeoutMs: 300_000,
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps/artifacts",
      "POST /v1/projects/:projectId/apps/artifacts/:artifactId/finalize",
      "POST /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments",
      "GET /v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
      "GET /v1/projects/:projectId/apps/:appId/deployments/:deploymentId/logs",
      "POST /v1/projects/:projectId/apps/:appId/rollback",
      "GET /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps/:appId/start",
      "POST /v1/projects/:projectId/apps/:appId/stop",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    const slug = ctx.fixtures.name("static").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    const apiOrigin = ctx.env.apiUrl.replace(/\/v1$/, "");
    const cli = new CliSandbox("app8");
    const asset = "assets/index-Qx7Lm2Pa.js";
    let appId = "";
    let appHost = "";
    const versions: string[] = [];

    const page = async (path: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${apiOrigin}${path}`, {
        headers: { host: `${appHost}:${new URL(apiOrigin).port}`, ...headers },
        redirect: "manual",
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    const writeSite = (marker: string, script: string) => {
      cli.writeFile("dist/index.html", `<!doctype html><title>${marker}</title><script src="/${asset}"></script>`);
      cli.writeFile(`dist/${asset}`, script);
      cli.writeFile("dist/robots.txt", "User-agent: *");
      cli.writeFile("dist/docs/index.html", `<!doctype html><title>docs ${marker}</title>`);
    };
    const deploy = async (marker: string, script = "console.log('app')") => {
      writeSite(marker, script);
      const started = Date.now();
      const result = await cli.run([
        "apps", "deploy", "dist", "--type", "static", "--spa", "--access", "public",
        ...(appId ? ["--app", appId] : ["--slug", slug, "--name", "ke2e static"]),
        "--project", project.id, "--json",
      ]);
      if (result.exitCode !== 0) throw new Error(`kortix apps deploy: ${result.exitCode} ${result.stderr}`);
      const out = JSON.parse(result.stdout);
      versions.push(out.deployment.deployment_id);
      return { out, ms: Date.now() - started };
    };

    try {
      await ctx.step("sign the CLI in", async () => {
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-app8") });
        const login = await cli.login(pat, { noProject: true, account: project.accountId });
        if (login.exitCode !== 0) throw new Error(`kortix login: ${login.stderr}`);
      });

      await ctx.step("kortix apps deploy of a built SPA is ready with no runtime: hosting_type static", async () => {
        const { out, ms } = await deploy("v1");
        appId = out.app.app_id;
        appHost = new URL(out.app.url).hostname;
        if (out.deployment.status !== "ready" || out.deployment.hosting_type !== "static") {
          throw new Error(`expected a ready static deployment, got ${out.deployment.status}/${out.deployment.hosting_type}`);
        }
        if (ms > 90_000) throw new Error(`a static deploy took ${ms} ms`);
        const read = await owner.get("/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
          { params: { ...projectParams, appId, deploymentId: versions[0]! } });
        read.status(200).body().has("$.deployment.hosting_type", "static").has("$.deployment.status", "ready");
      });

      await ctx.step("the App serves its files: shell, hashed asset, SPA deep link, 404 for a missing asset, 304", async () => {
        const home = await page("/");
        if (home.status !== 200 || !home.text.includes("<title>v1</title>")) {
          throw new Error(`GET /: ${home.status} ${home.text.slice(0, 120)}`);
        }
        if (home.headers.get("cache-control") !== "public, no-cache") {
          throw new Error(`HTML cache-control: ${home.headers.get("cache-control")}`);
        }
        const script = await page(`/${asset}`);
        if (script.status !== 200 || script.headers.get("cache-control") !== "public, max-age=31536000, immutable") {
          throw new Error(`asset: ${script.status} ${script.headers.get("cache-control")}`);
        }
        const deep = await page("/deals/42", { accept: "text/html" });
        if (deep.status !== 200 || !deep.text.includes("<title>v1</title>")) throw new Error(`deep link: ${deep.status}`);
        const missing = await page("/assets/missing-file.js", { accept: "*/*" });
        if (missing.status !== 404) throw new Error(`missing asset: ${missing.status}`);
        const revalidated = await page("/", { "if-none-match": home.headers.get("etag") ?? "" });
        if (revalidated.status !== 304) throw new Error(`If-None-Match: ${revalidated.status}`);
        if (revalidated.headers.get("vary") !== "accept-encoding") throw new Error(`304 vary: ${revalidated.headers.get("vary")}`);
      });

      await ctx.step("a directory URL without its slash redirects 308 to the slash, keeping the query; the slash URL serves its index", async () => {
        const bare = await page("/docs?tab=2");
        if (bare.status !== 308 || bare.headers.get("location") !== "/docs/?tab=2") {
          throw new Error(`GET /docs: ${bare.status} location ${bare.headers.get("location")}`);
        }
        if (bare.headers.get("cloudflare-cdn-cache-control") !== "no-store") {
          throw new Error(`redirect cloudflare-cdn-cache-control: ${bare.headers.get("cloudflare-cdn-cache-control")}`);
        }
        const slash = await page("/docs/");
        if (slash.status !== 200 || !slash.text.includes("<title>docs v1</title>")) throw new Error(`GET /docs/: ${slash.status}`);
      });

      await ctx.step("a redeploy uploads only the changed files and switches atomically", async () => {
        const { out } = await deploy("v2");
        if (out.deployment.status !== "ready") throw new Error(`v2 is ${out.deployment.status}`);
        const logs = await owner.get("/v1/projects/:projectId/apps/:appId/deployments/:deploymentId/logs",
          { params: { ...projectParams, appId, deploymentId: versions[1]! } });
        logs.status(200);
        if (!JSON.stringify(logs.json()).includes("(2 new, 2 unchanged)")) {
          throw new Error(`expected 2 new and 2 unchanged files: ${JSON.stringify(logs.json()).slice(0, 400)}`);
        }
        const home = await page("/");
        if (!home.text.includes("<title>v2</title>")) throw new Error(`v2 is not served: ${home.text.slice(0, 120)}`);
      });

      await ctx.step("rollback to v1 is a NEW release (v3) from v1's artifact: 202, ready in seconds with no runtime, v1's files served", async () => {
        const rolled = await owner.post("/v1/projects/:projectId/apps/:appId/rollback",
          { deployment_id: versions[0] }, { params: { ...projectParams, appId } });
        rolled.status(202).body().has("$.deployment.version", 3);
        const releaseId = rolled.json<any>().deployment.deployment_id as string;
        versions.push(releaseId);
        const ready = await waitFor(
          async () => (await owner.get("/v1/projects/:projectId/apps/:appId/deployments/:deploymentId",
            { params: { ...projectParams, appId, deploymentId: releaseId } })).json<any>().deployment,
          { until: (release) => release.status === "ready" || release.status === "failed", timeoutMs: 60_000, intervalMs: 500, description: "the rollback release" },
        );
        if (ready.status !== "ready" || ready.hosting_type !== "static") throw new Error(`rollback release: ${ready.status}/${ready.hosting_type}`);
        const home = await page("/");
        if (!home.text.includes("<title>v1</title>")) throw new Error(`v1 is not served after rollback`);
      });

      await ctx.step("a static App lists as hosting_type static with no estimate; start and stop answer 409 static_app_no_runtime on the API and the CLI; it keeps serving", async () => {
        const list = await owner.get("/v1/projects/:projectId/apps", { params: projectParams });
        list.status(200);
        const row = (list.json<any>().apps as Array<Record<string, unknown>>).find((app) => app.app_id === appId);
        if (row?.hosting_type !== "static" || row.estimated_monthly_usd !== 0 || row.retained_deployments !== 5) {
          throw new Error(`expected hosting_type static, estimate 0, retained 5: ${JSON.stringify(row)}`);
        }
        (await owner.post("/v1/projects/:projectId/apps/:appId/start", {}, { params: { ...projectParams, appId } }))
          .status(409).body().has("$.code", "static_app_no_runtime");
        (await owner.post("/v1/projects/:projectId/apps/:appId/stop", {}, { params: { ...projectParams, appId } }))
          .status(409).body().has("$.code", "static_app_no_runtime");
        const stop = await cli.run(["apps", "stop", appId, "--project", project.id]);
        if (stop.exitCode !== 1 || !stop.stderr.includes("no runtime to start or stop")) {
          throw new Error(`kortix apps stop: exit ${stop.exitCode}, stderr ${stop.stderr}`);
        }
        const ls = await cli.run(["apps", "ls", "--project", project.id]);
        if (ls.exitCode !== 0 || !new RegExp(`${slug}\\s+static\\s`).test(ls.stdout)) {
          throw new Error(`kortix apps ls does not print static: exit ${ls.exitCode}, stdout ${ls.stdout}, stderr ${ls.stderr}`);
        }
        const home = await page("/");
        if (home.status !== 200 || !home.text.includes("<title>v1</title>")) throw new Error(`not served after stop: ${home.status}`);
      });

      await ctx.step("retention: after 6 more deploys (v4-v9) the App keeps its active release and the 5 newest others", async () => {
        for (let i = 3; i <= 8; i += 1) await deploy(`v${i}`, `console.log(${i})`);
        const list = await owner.get("/v1/projects/:projectId/apps/:appId/deployments",
          { params: { ...projectParams, appId } });
        list.status(200);
        const rows = (list.json<any>().deployments ?? list.json<any>()) as Array<{ deployment_id: string; status: string; version: number }>;
        const ready = rows.filter((row) => row.status === "ready").map((row) => row.version).sort((a, b) => a - b);
        // Retired deployments are `deleted`, which the list leaves out.
        const listed = rows.map((row) => row.version);
        if (JSON.stringify(ready) !== JSON.stringify([4, 5, 6, 7, 8, 9]) || [1, 2, 3].some((version) => listed.includes(version))) {
          throw new Error(`expected exactly 4-9 ready and 1-3 retired, got ready ${ready}, listed ${listed}`);
        }
        const home = await page("/");
        if (!home.text.includes("<title>v8</title>")) throw new Error("the newest deployment is not served");
      });

      await ctx.step("delete the App", async () => {
        (await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } })).status(200);
        appId = "";
      });
    } finally {
      if (appId) await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } }).catch(() => {});
      cli.dispose();
    }
  },
);

flow(
  "APP-11",
  {
    domain: "apps",
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "GET /v1/projects/:projectId/apps/:appId/machines",
      "POST /v1/projects/:projectId/apps/:appId/machines/:machineId/start",
      "POST /v1/projects/:projectId/apps/:appId/machines/:machineId/stop",
      "POST /v1/projects/:projectId/apps/:appId/machines/:machineId/restart",
      "DELETE /v1/projects/:projectId/apps/:appId/machines/:machineId",
      "PUT /v1/projects/:projectId/apps/:appId/scale",
      "POST /v1/projects/:projectId/apps/:appId/exec",
      "GET /v1/projects/:projectId/apps/:appId/volumes",
      "POST /v1/projects/:projectId/apps/:appId/volumes",
      "PATCH /v1/projects/:projectId/apps/:appId/volumes/:volumeId",
      "DELETE /v1/projects/:projectId/apps/:appId/volumes/:volumeId",
      "GET /v1/projects/:projectId/apps/:appId/volumes/:volumeId/snapshots",
      "POST /v1/projects/:projectId/apps/:appId/volumes/:volumeId/snapshots",
      "POST /v1/projects/:projectId/apps/:appId/volumes/:volumeId/restore",
      "POST /v1/projects/:projectId/apps/:appId/volumes/:volumeId/fork",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const memberPrincipal = await team.addMember("member");
    await team.grantProjectRole(project.id, memberPrincipal.userId!, "member");
    const member = ctx.client.as(memberPrincipal);
    const slug = ctx.fixtures.name("fleet").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
    const cli = new CliSandbox("app9");
    let appId = "";
    let volumeId = "";
    const app = () => ({ projectId: project.id, appId });
    const vol = (id = volumeId) => ({ projectId: project.id, appId, volumeId: id });
    const machine = { projectId: project.id, appId: "", machineId: UNKNOWN_ID };

    try {
      await ctx.step("create an App with no release, sign the CLI in", async () => {
        const created = await owner.post("/v1/projects/:projectId/apps", { slug, name: "ke2e fleet App" }, { params: { projectId: project.id } });
        created.status(201);
        appId = created.json<any>().app_id;
        machine.appId = appId;
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-app9") });
        const login = await cli.login(pat, { noProject: true, account: project.accountId });
        if (login.exitCode !== 0) throw new Error(`kortix login: ${login.stderr}`);
      });

      await ctx.step("an App with no release lists no machines and no volumes", async () => {
        (await owner.get("/v1/projects/:projectId/apps/:appId/machines", { params: app() })).status(200).body().has("$.machines", []);
        (await owner.get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() })).status(200).body().has("$.volumes", []);
      });

      await ctx.step("scale and exec need a server release: 409 app_no_machines; kortix apps scale exits 1 with that reason", async () => {
        (await owner.put("/v1/projects/:projectId/apps/:appId/scale", { count: { app: 2 } }, { params: app() }))
          .status(409).body().has("$.code", "app_no_machines");
        (await owner.post("/v1/projects/:projectId/apps/:appId/exec", { command: ["true"] }, { params: app() }))
          .status(409).body().has("$.code", "app_no_machines");
        const scale = await cli.run(["apps", "scale", "count", slug, "2", "--project", project.id]);
        if (scale.exitCode !== 1 || !scale.stderr.includes("deploy a server release first")) {
          throw new Error(`kortix apps scale: exit ${scale.exitCode}, stderr ${scale.stderr}`);
        }
      });

      await ctx.step("start, stop, restart and destroy of an unknown machine → 404 machine_not_found", async () => {
        for (const action of ["start", "stop", "restart"] as const) {
          (await owner.post(`/v1/projects/:projectId/apps/:appId/machines/:machineId/${action}`, {}, { params: machine }))
            .status(404).body().has("$.code", "machine_not_found");
        }
        (await owner.del("/v1/projects/:projectId/apps/:appId/machines/:machineId", { params: machine }))
          .status(404).body().has("$.code", "machine_not_found");
      });

      await ctx.step("volume create refuses a bad name (400 volume_name_invalid) and a size outside 1-100 GB (400 volume_size_invalid)", async () => {
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes", { name: "Bad-Name", size_gb: 10 }, { params: app() }))
          .status(400).body().has("$.code", "volume_name_invalid");
        for (const size of [0, 101]) {
          (await owner.post("/v1/projects/:projectId/apps/:appId/volumes", { name: "data", size_gb: size }, { params: app() }))
            .status(400).body().has("$.code", "volume_size_invalid");
        }
      });

      await ctx.step("every volume route on an unknown volume → 404 volume_not_found", async () => {
        const unknown = vol(UNKNOWN_ID);
        (await owner.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { size_gb: 20 }, { params: unknown }))
          .status(404).body().has("$.code", "volume_not_found");
        (await owner.get("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/snapshots", { params: unknown }))
          .status(404).body().has("$.code", "volume_not_found");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/snapshots", {}, { params: unknown }))
          .status(404).body().has("$.code", "volume_not_found");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/restore", { snapshot_id: "manual-20261010" }, { params: unknown }))
          .status(404).body().has("$.code", "volume_not_found");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/fork", { name: "copy" }, { params: unknown }))
          .status(404).body().has("$.code", "volume_not_found");
        (await owner.del("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { params: unknown, query: { confirm: "data" } }))
          .status(404).body().has("$.code", "volume_not_found");
      });

      await ctx.step("a volume (seeded: the local profile has no Platinum) lists with its size, retention and attachment, adds the volumes capability; the CLI prints it", async () => {
        volumeId = await withDb(ctx, async (db) => {
          const accountId = (await db.query("SELECT account_id FROM kortix.apps WHERE app_id = $1", [appId])).rows[0].account_id as string;
          const inserted = await db.query(
            `INSERT INTO kortix.app_volumes (app_id, account_id, name, size_gb, external_id, status)
             VALUES ($1, $2, 'data', 10, $3, 'ready') RETURNING volume_id`,
            [appId, accountId, `ke2e-${ctx.fixtures.name("vol")}`],
          );
          return inserted.rows[0].volume_id as string;
        });
        const list = await owner.get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() });
        list.status(200);
        const row = (list.json<any>().volumes as Array<Record<string, unknown>>)[0];
        if (row?.volume_id !== volumeId || row.name !== "data" || row.size_gb !== 10 || row.attached !== false || row.snapshot_retention_days !== 5 || row.process_group !== "app") {
          throw new Error(`volume row: ${JSON.stringify(row)}`);
        }
        const shown = await owner.get("/v1/projects/:projectId/apps/:appId", { params: app() });
        shown.status(200);
        const capabilities = shown.json<any>().capabilities as string[];
        if (!capabilities.includes("volumes") || !capabilities.includes("snapshots") || capabilities.includes("machines")) {
          throw new Error(`capabilities with a volume and no server release: ${JSON.stringify(capabilities)}`);
        }
        const ls = await cli.run(["apps", "volumes", slug, "--project", project.id]);
        if (ls.exitCode !== 0 || !/data\s+app\s+-\s+10 GB/.test(ls.stdout)) throw new Error(`kortix apps volumes: exit ${ls.exitCode}, stdout ${ls.stdout}, stderr ${ls.stderr}`);
      });

      await ctx.step("a volume has a fixed size: 101 GB → 400 volume_size_invalid, retention 61 → 400, any other size without a provider → 503 volume_size_unknown; retention 7 → 200 and reads back; the CLI sets retention 30", async () => {
        (await owner.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { size_gb: 101 }, { params: vol() }))
          .status(400).body().has("$.code", "volume_size_invalid");
        (await owner.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { snapshot_retention_days: 61 }, { params: vol() }))
          .status(400).body().has("$.code", "volume_retention_invalid");
        (await owner.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { size_gb: 20 }, { params: vol() }))
          .status(503).body().has("$.code", "volume_size_unknown");
        (await owner.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { snapshot_retention_days: 7 }, { params: vol() }))
          .status(200).body().has("$.size_gb", 10).has("$.snapshot_retention_days", 7);
        const read = await owner.get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() });
        read.status(200).body().has("$.volumes[0].size_gb", 10).has("$.volumes[0].snapshot_retention_days", 7)
          .has("$.volumes[0].used_bytes", null).has("$.volumes[0].last_commit_at", null);
        const set = await cli.run(["apps", "volumes", "set", slug, "data", "--retention", "30", "--project", project.id]);
        if (set.exitCode !== 0 || !set.stdout.includes("keeps daily snapshots 30 days")) {
          throw new Error(`kortix apps volumes set: exit ${set.exitCode}, stdout ${set.stdout}, stderr ${set.stderr}`);
        }
      });

      await ctx.step("destroy needs ?confirm=<name> (400 confirmation_required); restore and fork refuse an unknown snapshot (400 snapshot_invalid); fork refuses a bad name", async () => {
        (await owner.del("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { params: vol() }))
          .status(400).body().has("$.code", "confirmation_required");
        (await owner.del("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { params: vol(), query: { confirm: "other" } }))
          .status(400).body().has("$.code", "confirmation_required");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/restore", { snapshot_id: "yesterday" }, { params: vol() }))
          .status(400).body().has("$.code", "snapshot_invalid");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/fork", { name: "copy", snapshot_id: "yesterday" }, { params: vol() }))
          .status(400).body().has("$.code", "snapshot_invalid");
        (await owner.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/fork", { name: "Bad-Copy" }, { params: vol() }))
          .status(400).body().has("$.code", "volume_name_invalid");
      });

      await ctx.step("a project member (no deploy, no admin) is refused every write: 403 on scale, exec, machine start, volume create, extend, snapshot, restore, fork, destroy and App delete", async () => {
        const refusals = [
          await member.put("/v1/projects/:projectId/apps/:appId/scale", { count: { app: 1 } }, { params: app() }),
          await member.post("/v1/projects/:projectId/apps/:appId/exec", { command: ["true"] }, { params: app() }),
          await member.post("/v1/projects/:projectId/apps/:appId/machines/:machineId/start", {}, { params: machine }),
          await member.post("/v1/projects/:projectId/apps/:appId/volumes", { name: "more", size_gb: 10 }, { params: app() }),
          await member.patch("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { size_gb: 30 }, { params: vol() }),
          await member.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/snapshots", {}, { params: vol() }),
          await member.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/restore", { snapshot_id: "manual-20261010" }, { params: vol() }),
          await member.post("/v1/projects/:projectId/apps/:appId/volumes/:volumeId/fork", { name: "copy" }, { params: vol() }),
          await member.del("/v1/projects/:projectId/apps/:appId/volumes/:volumeId", { params: vol(), query: { confirm: "data" } }),
          await member.del("/v1/projects/:projectId/apps/:appId", { params: app() }),
        ];
        refusals.forEach((response) => response.status(403));
        (await owner.get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() })).status(200).body()
          .has("$.volumes[0].size_gb", 10).has("$.volumes[0].snapshot_retention_days", 30);
      });

      await ctx.step("NONMEMBER learns nothing (403/404); ANON → 401", async () => {
        (await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/apps/:appId/machines", { params: app() })).status([403, 404]);
        (await ctx.client.as(ctx.P.NONMEMBER).get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() })).status([403, 404]);
        (await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/apps/:appId/volumes", { params: app() })).status(401);
      });

      await ctx.step("delete the App", async () => {
        await withDb(ctx, (db) => db.query("DELETE FROM kortix.app_volumes WHERE volume_id = $1", [volumeId]));
        volumeId = "";
        (await owner.del("/v1/projects/:projectId/apps/:appId", { params: app() })).status(200);
        appId = "";
      });
    } finally {
      if (volumeId) await withDb(ctx, (db) => db.query("DELETE FROM kortix.app_volumes WHERE volume_id = $1", [volumeId])).catch(() => {});
      if (appId) await owner.del("/v1/projects/:projectId/apps/:appId", { params: app() }).catch(() => {});
      cli.dispose();
    }
  },
);
