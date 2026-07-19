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

// SEC-7 — agent-minted secret setup links: the authenticated mint side
// (POST /secret-requests, projects/routes/setup-links.ts) and the PUBLIC,
// token-gated consume side (GET/POST /v1/setup-links/secret/:token,
// setup-links/public-app.ts). The token is a stateless AEAD envelope (no DB
// row) encrypted with the project's own key — see setup-links/token.ts. Full
// mint → resolve → submit lifecycle, plus the bogus-token boundary on both
// public routes.
flow(
  "SEC-7",
  {
    domain: "secrets",
    routes: [
      "POST /v1/projects/:projectId/secret-requests",
      "GET /v1/setup-links/secret/:token",
      "POST /v1/setup-links/secret/:token",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let token = "";

    await ctx.step("mint a secret-entry link → 200 with a token url", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_TEST_KEY"] },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.kind", "secret").has("$.names[0]", "SEC7_TEST_KEY").exists("$.url");
      const url = r.json<{ url: string }>().url;
      token = url.split("/").pop() ?? "";
      if (!token) throw new Error(`could not extract token from mint url: ${url}`);
    });

    await ctx.step("mint rejects a KORTIX_* reserved name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["KORTIX_HACK"] },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });

    await ctx.step("mint with no names → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/secret-requests", {}, { params: { projectId: p.id } });
      r.status(400);
    });

    await ctx.step("NONMEMBER cannot mint → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/secret-requests",
          { names: ["SEC7_TEST_KEY"] },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });

    await ctx.step("public: resolve the real token → 200 with the requested field", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/setup-links/secret/:token", { params: { token } });
      r.status(200).body().has("$.kind", "secret").has("$.fields[0].name", "SEC7_TEST_KEY");
    });

    await ctx.step("public: resolve a bogus token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/setup-links/secret/:token", { params: { token: "ksl_bogus" } });
      r.status(404);
    });

    await ctx.step("public: submit a value for the real token → 200 saved", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/setup-links/secret/:token",
          { values: { SEC7_TEST_KEY: "e2e-value" } },
          { params: { token } },
        );
      r.status(200).body().has("$.ok", true).has("$.saved[0]", "SEC7_TEST_KEY");
    });

    await ctx.step("public: submit with no matching values → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/setup-links/secret/:token", { values: { UNREQUESTED_KEY: "x" } }, { params: { token } });
      r.status(400);
    });

    await ctx.step("public: submit against a bogus token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/setup-links/secret/:token",
          { values: { SEC7_TEST_KEY: "x" } },
          { params: { token: "ksl_bogus" } },
        );
      r.status(404);
    });
  },
);
