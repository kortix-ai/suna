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
 *
 * APP-10: one sign-in issuer per project, tokens for any App as audience, and
 * the App host's `/_kortix/token` and bindings mount gated by `uses` links.
 */
import { createPublicKey, verify } from "node:crypto";
import { flow } from "../core/flow";
import { CliSandbox } from "../fixtures/cli";
import { setFeatureAsOperator } from "../fixtures/feature-flags";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

const CAPABILITY_ROUTES = [
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/snapshots", capability: "snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/snapshots", capability: "snapshots" },
  { method: "del", path: "/v1/projects/:projectId/apps/:appId/snapshots/:snapshotId", capability: "snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/restore", capability: "restore" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/credentials", capability: "admin_credentials" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/rotate-credentials", capability: "admin_credentials" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/logs", capability: "logs" },
] as const;

flow(
  "APP-9",
  {
    domain: "apps",
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "GET /v1/projects/:projectId/apps/:appId",
      "DELETE /v1/projects/:projectId/apps/:appId",
      "GET /v1/projects/:projectId/apps/:appId/snapshots",
      "POST /v1/projects/:projectId/apps/:appId/snapshots",
      "DELETE /v1/projects/:projectId/apps/:appId/snapshots/:snapshotId",
      "POST /v1/projects/:projectId/apps/:appId/restore",
      "GET /v1/projects/:projectId/apps/:appId/credentials",
      "POST /v1/projects/:projectId/apps/:appId/rotate-credentials",
      "GET /v1/projects/:projectId/apps/:appId/logs",
      "GET /v1/projects/:projectId/apps",
      "PATCH /v1/projects/:projectId/apps/:appId",
      "POST /v1/projects/:projectId/apps/:appId/token",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const projectParams = { projectId: project.id };
    let webAppId = "";
    let otherAppId = "";
    let convexAppId = "";
    const convexSlug = `cvx-${ctx.fixtures.name("main").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)}`.replace(/-+$/, "");

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
        { kind: "convex", slug: convexSlug, name: "main", uses: [] },
        { params: projectParams },
      );
      create.status([201, 409]);
      if (create.statusCode === 409) {
        create.body().has("$.code", "app_kind_unavailable");
      } else {
        convexAppId = create.json<{ app_id: string }>().app_id;
        create
          .body()
          .has("$.kind", "convex")
          .has("$.always_on", true)
          .has("$.instance.status", "provisioning")
          .has("$.capabilities", ["deployments", "snapshots", "restore", "admin_credentials", "dashboard", "logs", "member_tokens"]);
      }
    });

    await ctx.step("a web App lacks every convex capability route: 409 app_capability_unsupported naming the capability", async () => {
      const created = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug: ctx.fixtures.name("site").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40), name: "site" },
        { params: projectParams },
      );
      created.status(201).body().has("$.kind", "web").has("$.capabilities", ["deployments", "rollback", "preview", "member_tokens"]);
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

    await ctx.step("the real CLI: link/unlink set `uses`, show prints kind and capabilities, a missing capability exits 1 before the route, token prints a JWT", async () => {
      const otherSlug = ctx.fixtures.name("other").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40).replace(/-+$/, "");
      const other = await owner.post("/v1/projects/:projectId/apps", { slug: otherSlug, name: "other" }, { params: projectParams });
      other.status(201);
      otherAppId = other.json<{ app_id: string }>().app_id;
      const cli = new CliSandbox("app9");
      try {
        const pat = await ctx.fixtures.pat({ name: ctx.fixtures.name("cli-app9") });
        const login = await cli.login(pat, { noProject: true, account: project.accountId });
        if (login.exitCode !== 0) throw new Error(`kortix login: ${login.stderr}`);
        const P = ["--project", project.id];

        const link = await cli.run(["apps", "link", webAppId, "--uses", otherSlug, ...P, "--json"]);
        if (link.exitCode !== 0) throw new Error(`kortix apps link: ${link.exitCode} ${link.stderr}`);
        if (JSON.stringify(JSON.parse(link.stdout).uses) !== JSON.stringify([otherSlug])) {
          throw new Error(`link answered uses ${link.stdout.slice(0, 300)}`);
        }
        (await owner.get("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId: otherAppId } }))
          .status(200)
          .body()
          .has("$.used_by", [JSON.parse(link.stdout).slug]);

        const show = await cli.run(["apps", "show", webAppId, ...P, "--json"]);
        if (show.exitCode !== 0) throw new Error(`kortix apps show: ${show.exitCode} ${show.stderr}`);
        const shown = JSON.parse(show.stdout).app as { kind: string; capabilities: string[]; uses: string[] };
        if (shown.kind !== "web" || !shown.capabilities.includes("member_tokens") || shown.uses[0] !== otherSlug) {
          throw new Error(`show printed ${JSON.stringify(shown)}`);
        }

        const snapshots = await cli.run(["apps", "snapshots", webAppId, ...P]);
        if (snapshots.exitCode !== 1 || !/\(kind web\) does not support snapshots/.test(snapshots.stderr)) {
          throw new Error(`kortix apps snapshots on a web App: ${snapshots.exitCode} ${snapshots.stderr}`);
        }

        const token = await cli.run(["apps", "token", webAppId, ...P]);
        if (token.exitCode !== 0 || token.stdout.trim().split(".").length !== 3) {
          throw new Error(`kortix apps token: ${token.exitCode} ${token.stderr} ${token.stdout.slice(0, 80)}`);
        }

        const unlink = await cli.run(["apps", "unlink", webAppId, "--uses", otherSlug, ...P, "--json"]);
        if (unlink.exitCode !== 0 || JSON.parse(unlink.stdout).uses.length !== 0) {
          throw new Error(`kortix apps unlink: ${unlink.exitCode} ${unlink.stderr}`);
        }
      } finally {
        cli.dispose();
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

    await ctx.step("a convex App delete needs its typed slug (400 confirmation_required), then answers 200 with retained_until", async () => {
      if (!convexAppId) return;
      const params = { ...projectParams, appId: convexAppId };
      (await owner.del("/v1/projects/:projectId/apps/:appId", { params }))
        .status(400)
        .body()
        .has("$.code", "confirmation_required");
      (await owner.del("/v1/projects/:projectId/apps/:appId", { params, query: { confirm: convexSlug } }))
        .status(200)
        .body()
        .exists("$.retained_until");
      (await owner.get("/v1/projects/:projectId/apps/:appId", { params })).status(404);
    });

    await ctx.step("cleanup: delete the web App, clear the flag override", async () => {
      for (const appId of [webAppId, otherAppId].filter(Boolean)) {
        (await owner.del("/v1/projects/:projectId/apps/:appId", { params: { ...projectParams, appId } })).status(200);
      }
      await setFeatureAsOperator(ctx, project.id, "apps", null);
    });
  },
);

type Claims = { iss: string; aud: string; sub: string; exp: number; iat: number; project_id: string };

/** The claims of an ES256 JWT, after checking its signature against a published key set. */
function verifiedClaims(token: string, jwks: { keys: Array<Record<string, unknown>> }): Claims {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString()) as { kid: string; alg: string };
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (header.alg !== "ES256" || !jwk) throw new Error(`no key ${header.kid} in the published key set`);
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(s!, "base64url"),
  );
  if (!ok) throw new Error("the token signature does not verify against the project key set");
  return JSON.parse(Buffer.from(p!, "base64url").toString()) as Claims;
}

flow(
  "APP-10",
  {
    domain: "apps",
    requires: ["appHost"],
    timeoutMs: 180_000,
    routes: [
      "PUT /v1/admin/api/projects/:id/features",
      "POST /v1/projects/:projectId/apps",
      "POST /v1/projects/:projectId/apps/:appId/token",
      "POST /v1/projects/:projectId/apps/:appId/access-session",
      "GET /v1/projects/:projectId/.well-known/openid-configuration",
      "GET /v1/projects/:projectId/jwks.json",
      "DELETE /v1/projects/:projectId/apps/:appId",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const otherProject = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    const apiOrigin = ctx.env.apiUrl.replace(/\/v1$/, "");
    const issuer = `${apiOrigin}/v1/projects/${project.id}`;
    const slug = (name: string) => ctx.fixtures.name(name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40).replace(/-+$/, "");
    const names = { a: slug("tok-a"), b: slug("tok-b"), c: slug("tok-c"), d: slug("tok-d") };
    const ids: Record<"a" | "b" | "c" | "d", string> = { a: "", b: "", c: "", d: "" };
    let appHost = "";
    let cookie = "";
    let jwks: { keys: Array<Record<string, unknown>> } = { keys: [] };

    // The gate, at App A's own hostname. Local Apps answer under
    // `<route-key>.apps.localhost`; the API honours `x-kortix-app-host` there.
    const gate = async (pathAndQuery: string) => {
      const response = await fetch(`${apiOrigin}${pathAndQuery}`, {
        headers: { accept: "application/json", "x-kortix-app-host": appHost, ...(cookie ? { cookie } : {}) },
        redirect: "manual",
      });
      const text = await response.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, headers: response.headers, body, text };
    };
    const expectGate = async (pathAndQuery: string, status: number, code?: string) => {
      const r = await gate(pathAndQuery);
      const got = r.body?.error ?? r.body?.code;
      if (r.status !== status || (code && r.body?.error !== code && r.body?.code !== code)) {
        throw new Error(`${pathAndQuery}: expected ${status} ${code ?? ""}, got ${r.status} ${got ?? r.text.slice(0, 200)}`);
      }
      return r;
    };

    try {
      await ctx.step("ANON reads the project issuer: openid-configuration names it and its key set; unknown → 404, malformed → 400", async () => {
        (await anon.get("/v1/projects/:projectId/.well-known/openid-configuration", { params: { projectId: project.id } }))
          .status(200)
          .body()
          .has("$.issuer", issuer)
          .has("$.jwks_uri", `${issuer}/jwks.json`);
        (await anon.get("/v1/projects/:projectId/jwks.json", { params: { projectId: UNKNOWN_ID } })).status(404);
        (await anon.get("/v1/projects/:projectId/.well-known/openid-configuration", { params: { projectId: UNKNOWN_ID } })).status(404);
        (await anon.get("/v1/projects/:projectId/jwks.json", { params: { projectId: "not-a-uuid" } })).status(400);
      });

      await ctx.step("enable Apps in both projects; create C, B, and A that uses C in one, D in the other", async () => {
        await setFeatureAsOperator(ctx, project.id, "apps", true);
        await setFeatureAsOperator(ctx, otherProject.id, "apps", true);
        const create = async (projectId: string, name: string, uses: string[] = []) => {
          const created = await owner.post("/v1/projects/:projectId/apps", { slug: name, name, uses }, { params: { projectId } });
          created.status(201).body().has("$.uses", uses);
          return created.json<{ app_id: string; url: string; auth: { issuer: string; audience: string } }>();
        };
        ids.c = (await create(project.id, names.c)).app_id;
        ids.b = (await create(project.id, names.b)).app_id;
        const a = await create(project.id, names.a, [names.c]);
        ids.a = a.app_id;
        if (a.auth.issuer !== issuer || a.auth.audience !== ids.a) throw new Error(`App auth ${JSON.stringify(a.auth)}`);
        appHost = new URL(a.url).hostname;
        ids.d = (await create(otherProject.id, names.d)).app_id;
      });

      await ctx.step("the owner mints a member token for A: aud = A, iss = the project, verified with the published key set", async () => {
        const minted = await owner.post("/v1/projects/:projectId/apps/:appId/token", {}, { params: { projectId: project.id, appId: ids.a } });
        minted.status(200).body().exists("$.token").exists("$.expires_at");
        jwks = (await anon.get("/v1/projects/:projectId/jwks.json", { params: { projectId: project.id } })).status(200).json();
        const claims = verifiedClaims(minted.json<{ token: string }>().token, jwks);
        if (claims.iss !== issuer || claims.aud !== ids.a || claims.project_id !== project.id) {
          throw new Error(`claims ${JSON.stringify(claims)}`);
        }
        if (claims.exp - claims.iat !== 900) throw new Error(`lifetime ${claims.exp - claims.iat} s, want 900`);
      });

      await ctx.step("NONMEMBER mints nothing (403/404); ANON → 401", async () => {
        const params = { projectId: project.id, appId: ids.a };
        (await ctx.client.as(ctx.P.NONMEMBER).post("/v1/projects/:projectId/apps/:appId/token", {}, { params })).status([403, 404]);
        (await anon.post("/v1/projects/:projectId/apps/:appId/token", {}, { params })).status(401);
      });

      await ctx.step("sign in to A through its access link", async () => {
        const session = await owner.post(
          "/v1/projects/:projectId/apps/:appId/access-session",
          {},
          { params: { projectId: project.id, appId: ids.a } },
        );
        session.status(200);
        const link = new URL(session.json<any>().url);
        const redeemed = await gate(`${link.pathname}${link.search}`);
        cookie = redeemed.headers.get("set-cookie")?.split(";")[0] ?? "";
        if (redeemed.status !== 303 || !cookie) {
          throw new Error(`access link did not sign in: ${redeemed.status} ${redeemed.text.slice(0, 200)}`);
        }
      });

      await ctx.step("/_kortix/token: 200 for A itself (default) and for C that A uses, by slug and by id", async () => {
        for (const [query, audience] of [["", ids.a], [`?audience=${names.c}`, ids.c], [`?audience=${ids.c}`, ids.c]] as const) {
          const r = await expectGate(`/_kortix/token${query}`, 200);
          if (r.headers.get("cache-control") !== "no-store") throw new Error("token answer is cacheable");
          const claims = verifiedClaims(r.body.token, jwks);
          if (claims.aud !== audience || claims.iss !== issuer) throw new Error(`claims ${JSON.stringify(claims)}`);
        }
      });

      await ctx.step("/_kortix/token: 403 app_not_linked for B (same project, not used) and for D (another project)", async () => {
        await expectGate(`/_kortix/token?audience=${names.b}`, 403, "app_not_linked");
        await expectGate(`/_kortix/token?audience=${ids.b}`, 403, "app_not_linked");
        await expectGate(`/_kortix/token?audience=${ids.d}`, 403, "app_not_linked");
        await expectGate(`/_kortix/token?audience=${names.d}`, 403, "app_not_linked");
      });

      await ctx.step("bindings mount: 403 app_not_linked for B and D, 409 app_binding_unsupported for C (a web App has no endpoint)", async () => {
        await expectGate(`/_kortix/apps/${names.b}/api/version`, 403, "app_not_linked");
        await expectGate(`/_kortix/apps/${names.d}/`, 403, "app_not_linked");
        await expectGate(`/_kortix/apps/${names.c}/api/version`, 409, "app_binding_unsupported");
      });
    } finally {
      for (const [projectId, appId] of [[project.id, ids.a], [project.id, ids.b], [project.id, ids.c], [otherProject.id, ids.d]]) {
        if (appId) await owner.del("/v1/projects/:projectId/apps/:appId", { params: { projectId, appId } }).catch(() => {});
      }
      await setFeatureAsOperator(ctx, project.id, "apps", null).catch(() => {});
      await setFeatureAsOperator(ctx, otherProject.id, "apps", null).catch(() => {});
    }
  },
);
