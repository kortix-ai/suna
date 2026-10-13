/**
 * The App capability surface, links and sign-in tokens. Clients branch on
 * `capabilities`; the capability routes that retired with the `convex` kind
 * (snapshots, restore, credentials, logs) answer 404. Maps to spec section 34
 * (APP-9).
 *
 * APP-10: one sign-in issuer per project, tokens for any App as audience, and
 * the App host's `/_kortix/token` and bindings mount gated by `uses` links.
 */
import { createPublicKey, verify } from "node:crypto";
import { flow } from "../core/flow";
import { CliSandbox } from "../fixtures/cli";
import { stagingAppsEdgeQuarantine } from "../fixtures/apps-edge";
import { setFeatureAsOperator } from "../fixtures/feature-flags";

const UNKNOWN_ID = "00000000-0000-4000-a000-000000000000";

const RETIRED_ROUTES = [
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/snapshots" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/restore" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/credentials" },
  { method: "post", path: "/v1/projects/:projectId/apps/:appId/rotate-credentials" },
  { method: "get", path: "/v1/projects/:projectId/apps/:appId/logs" },
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
    const appSlug = (name: string) => ctx.fixtures.name(name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40).replace(/-+$/, "");

    await ctx.step("apps flag off: the token route answers 403 feature_disabled", async () => {
      await setFeatureAsOperator(ctx, project.id, "apps", null);
      const params = { ...projectParams, appId: UNKNOWN_ID };
      (await owner.post("/v1/projects/:projectId/apps/:appId/token", {}, { params }))
        .status(403)
        .body()
        .has("$.code", "feature_disabled");
    });

    await ctx.step("an operator enables apps; an invalid slug answers 400", async () => {
      await setFeatureAsOperator(ctx, project.id, "apps", true);
      (
        await owner.post("/v1/projects/:projectId/apps", { slug: "Bad Slug", name: "x" }, { params: projectParams })
      ).status(400);
    });

    await ctx.step("a create answers 201 with capabilities, no kind, no instance and no budget; a `kind` in the body is ignored", async () => {
      const created = await owner.post(
        "/v1/projects/:projectId/apps",
        { slug: appSlug("site"), name: "site", kind: "convex" },
        { params: projectParams },
      );
      created.status(201).body().has("$.capabilities", ["deployments", "rollback", "preview", "member_tokens"]);
      const body = created.json<Record<string, unknown>>();
      for (const retired of ["kind", "instance", "monthly_budget_usd"]) {
        if (retired in body) throw new Error(`an App carries ${retired}: ${created.text()}`);
      }
      webAppId = created.json<{ app_id: string }>().app_id;
    });

    await ctx.step("the capability routes that retired with the convex kind answer 404", async () => {
      const params = { ...projectParams, appId: webAppId, snapshotId: "snap_none" };
      for (const route of RETIRED_ROUTES) {
        const response =
          route.method === "get" ? await owner.get(route.path, { params }) : await owner.post(route.path, {}, { params });
        response.status(404);
      }
    });

    await ctx.step("the real CLI: link/unlink set `uses`, show prints capabilities, a retired subcommand exits nonzero, token prints a JWT", async () => {
      const otherSlug = appSlug("other");
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
        const shown = JSON.parse(show.stdout).app as { kind?: string; capabilities: string[]; uses: string[] };
        if (shown.kind !== undefined || !shown.capabilities.includes("member_tokens") || shown.uses[0] !== otherSlug) {
          throw new Error(`show printed ${JSON.stringify(shown)}`);
        }

        const snapshots = await cli.run(["apps", "snapshots", webAppId, ...P]);
        if (snapshots.exitCode === 0 || !/unknown Apps subcommand "snapshots"/.test(snapshots.stderr)) {
          throw new Error(`kortix apps snapshots: ${snapshots.exitCode} ${snapshots.stderr}`);
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

    await ctx.step("an unknown App answers 404 on the token route", async () => {
      (await owner.post("/v1/projects/:projectId/apps/:appId/token", {}, { params: { ...projectParams, appId: UNKNOWN_ID } })).status(404);
    });

    await ctx.step("NONMEMBER learns nothing (403/404); ANON → 401", async () => {
      const params = { ...projectParams, appId: webAppId };
      (await ctx.client.as(ctx.P.NONMEMBER).post("/v1/projects/:projectId/apps/:appId/token", {}, { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.ANON).post("/v1/projects/:projectId/apps/:appId/token", {}, { params })).status(401);
    });

    await ctx.step("cleanup: delete the Apps, clear the flag override", async () => {
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
    ...stagingAppsEdgeQuarantine(),
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
    // `<route-key>.apps.localhost`: the Host names the App (an unsigned
    // `x-kortix-app-host` claim is never trusted).
    const gate = async (pathAndQuery: string) => {
      const response = await fetch(`${apiOrigin}${pathAndQuery}`, {
        headers: { accept: "application/json", host: `${appHost}:${new URL(apiOrigin).port}`, ...(cookie ? { cookie } : {}) },
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

      await ctx.step("bindings mount: 403 app_not_linked for B and D, 503 app_binding_unavailable for C (used, but no release runs)", async () => {
        await expectGate(`/_kortix/apps/${names.b}/api/version`, 403, "app_not_linked");
        await expectGate(`/_kortix/apps/${names.d}/`, 403, "app_not_linked");
        await expectGate(`/_kortix/apps/${names.c}/api/version`, 503, "app_binding_unavailable");
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
