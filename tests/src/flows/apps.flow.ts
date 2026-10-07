/**
 * Kortix Apps — project-owned serverless App CRUD, artifact registration, and
 * deployment lifecycle boundaries, the App viewer token, and deleting an App
 * or one deployment together with its provider images. Maps to spec section 28
 * (APP-1..7).
 */
import { flow } from "../core/flow";
import { CliSandbox } from "../fixtures/cli";

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

    await ctx.step("create returns stable App policy and URL; an always-on App below its 24/7 estimate is warned, not refused", async () => {
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
        .has("$.desired_state", "running")
        .has("$.always_on", true)
        .has("$.estimated_monthly_usd", 73.48)
        .has("$.warnings[0].code", "app_budget_below_always_on");
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
        .has("$.idle_timeout_seconds", 420)
        .has("$.warnings", []);

      const funded = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { monthly_budget_usd: 100 },
        { params },
      );
      funded.status(200).body().has("$.monthly_budget_usd", 100).has("$.warnings", []);
      const underfunded = await owner.patch(
        "/v1/projects/:projectId/apps/:appId",
        { monthly_budget_usd: 10 },
        { params },
      );
      underfunded.status(200).body().has("$.warnings[0].code", "app_budget_below_always_on");
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

flow(
  "APP-5",
  {
    domain: "apps",
    routes: [
      "PATCH /v1/projects/:projectId/features",
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

    await ctx.step("enable the apps flag", async () => {
      const response = await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      );
      response.status(200);
    });

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
      "PATCH /v1/projects/:projectId/features",
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
    // `<route-key>.apps.localhost`; the API honours `x-kortix-app-host` there.
    const gate = async (pathAndQuery: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${apiOrigin}${pathAndQuery}`, {
        headers: { accept: "application/json", "x-kortix-app-host": appHost, ...headers },
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
      await ctx.step("enable Apps; create an App restricted to the viewer that acts as them (api scope)", async () => {
        (await owner.patch("/v1/projects/:projectId/features", { feature: "apps", enabled: true },
          { params: projectParams })).status(200);
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

      await ctx.step("an identity-scoped App's token names the viewer but opens no project route (403)", async () => {
        const session = await viewerToken(await signIn());
        if (JSON.stringify(session.scopes) !== JSON.stringify(["profile", "email"]) || !session.access_token) {
          throw new Error(`identity scope returned ${JSON.stringify(session.scopes)}`);
        }
        (await asToken(session.access_token).get("/v1/projects/:projectId", { params: projectParams })).status(403);
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
      "PATCH /v1/projects/:projectId/features",
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

    await ctx.step("enable the apps flag", async () => {
      (await owner.patch(
        "/v1/projects/:projectId/features",
        { feature: "apps", enabled: true },
        { params: projectParams },
      )).status(200);
    });

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
      "PATCH /v1/projects/:projectId/features",
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
        headers: { "x-kortix-app-host": appHost, ...headers },
        redirect: "manual",
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    };
    const writeSite = (marker: string, script: string) => {
      cli.writeFile("dist/index.html", `<!doctype html><title>${marker}</title><script src="/${asset}"></script>`);
      cli.writeFile(`dist/${asset}`, script);
      cli.writeFile("dist/robots.txt", "User-agent: *");
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
      await ctx.step("enable Apps and sign the CLI in", async () => {
        (await owner.patch("/v1/projects/:projectId/features", { feature: "apps", enabled: true },
          { params: projectParams })).status(200);
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
      });

      await ctx.step("a redeploy uploads only the changed file and switches atomically", async () => {
        const { out } = await deploy("v2");
        if (out.deployment.status !== "ready") throw new Error(`v2 is ${out.deployment.status}`);
        const logs = await owner.get("/v1/projects/:projectId/apps/:appId/deployments/:deploymentId/logs",
          { params: { ...projectParams, appId, deploymentId: versions[1]! } });
        logs.status(200);
        if (!JSON.stringify(logs.json()).includes("(1 new, 2 unchanged)")) {
          throw new Error(`expected 1 new and 2 unchanged files: ${JSON.stringify(logs.json()).slice(0, 400)}`);
        }
        const home = await page("/");
        if (!home.text.includes("<title>v2</title>")) throw new Error(`v2 is not served: ${home.text.slice(0, 120)}`);
      });

      await ctx.step("rollback to v1 is a pointer flip: no runtime to start", async () => {
        const rolled = await owner.post("/v1/projects/:projectId/apps/:appId/rollback",
          { deployment_id: versions[0] }, { params: { ...projectParams, appId } });
        rolled.status(200).body().has("$.active_deployment_id", versions[0]);
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
          throw new Error(`kortix apps ls does not print static: ${ls.stdout}`);
        }
        const home = await page("/");
        if (home.status !== 200 || !home.text.includes("<title>v1</title>")) throw new Error(`not served after stop: ${home.status}`);
      });

      await ctx.step("retention: after 8 deploys the App keeps its active deployment and the 5 newest others", async () => {
        for (let i = 3; i <= 8; i += 1) await deploy(`v${i}`, `console.log(${i})`);
        const list = await owner.get("/v1/projects/:projectId/apps/:appId/deployments",
          { params: { ...projectParams, appId } });
        list.status(200);
        const rows = (list.json<any>().deployments ?? list.json<any>()) as Array<{ deployment_id: string; status: string; version: number }>;
        const ready = rows.filter((row) => row.status === "ready").map((row) => row.version).sort((a, b) => a - b);
        // Retired deployments are `deleted`, which the list leaves out.
        const listed = rows.map((row) => row.version);
        if (JSON.stringify(ready) !== JSON.stringify([3, 4, 5, 6, 7, 8]) || listed.includes(1) || listed.includes(2)) {
          throw new Error(`expected exactly 3-8 ready and 1-2 retired, got ready ${ready}, listed ${listed}`);
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
