/**
 * Connectors (executor) — catalog, project connector admin, policies,
 * credentials, call gateway. Connectors are project-wide visible (no
 * per-connector sharing/agent-scope — retired 2026-07-06, see
 * spec/end-to-end.md §24). Maps to spec §24 (CONN-1..5, 7-9, 12-14).
 */
import { flow } from "../core/flow";

flow("CONN-1", { domain: "connectors", tags: ["smoke"], routes: ["GET /v1/executor/connectors"] }, async (ctx) => {
  // The catalog + /call are executor-principal routes (the sandbox runtime calls
  // them with a project/sandbox KORTIX_TOKEN). A bare user JWT is NOT an executor
  // principal → 401; ANON → 401. The 200 path is exercised by the in-sandbox
  // executor (covered by sandbox/agent-run flows), not a dashboard JWT.
  await ctx.step("user JWT is not an executor principal → 401", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/connectors");
    r.status(401);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/executor/connectors");
    r.status(401);
  });
});

flow("CONN-2", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/connectors"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("project admin lists connectors", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/connectors", { params: { projectId: p.id } });
    r.status(200);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/executor/projects/:projectId/connectors", { params: { projectId: p.id } });
    r.status(403);
  });
});

flow("CONN-3", { domain: "connectors", routes: ["POST /v1/executor/call"] }, async (ctx) => {
  // /call is executor-principal only: a user JWT and ANON both → 401 (the real
  // caller is the sandbox runtime with KORTIX_TOKEN).
  await ctx.step("user JWT → 401", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/executor/call", {});
    r.status(401);
  });
  await ctx.step("ANON → 401", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/executor/call", { connector: "x", action: "y" });
    r.status(401);
  });
});

flow("CONN-4", { domain: "connectors", routes: ["POST /v1/executor/projects/:projectId/connectors/sync"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("sync re-materializes from kortix.yaml → 200", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post("/v1/executor/projects/:projectId/connectors/sync", {}, { params: { projectId: p.id } });
    r.status(200);
  });
});

flow(
  "CONN-5",
  { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/policies", "PUT /v1/executor/projects/:projectId/policies"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("read policies → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/policies", { params: { projectId: p.id } });
      r.status([200, 501]);
    });
    await ctx.step("replace policies → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).put("/v1/executor/projects/:projectId/policies", { policies: [] }, { params: { projectId: p.id } });
      r.status([200, 501]);
    });
  },
);

flow("CONN-7", { domain: "connectors", routes: ["PUT /v1/executor/projects/:projectId/connectors/:slug/credential"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("missing value → 400", async () => {
    const r = await ctx.client
      .as(ctx.P.OWNER)
      .put("/v1/executor/projects/:projectId/connectors/:slug/credential", {}, { params: { projectId: p.id, slug: "nope" } });
    r.status(400);
  });
});

flow(
  "CONN-8",
  { domain: "connectors", routes: ["POST /v1/executor/projects/:projectId/connectors", "DELETE /v1/executor/projects/:projectId/connectors/:slug"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("invalid json add → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/executor/projects/:projectId/connectors", "not json", { params: { projectId: p.id }, raw: true, headers: { "content-type": "application/json" } });
      r.status([400, 501]);
    });
    await ctx.step("delete unknown connector → ok/404/400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/executor/projects/:projectId/connectors/:slug", { params: { projectId: p.id, slug: "nope" } });
      r.status([200, 400, 404, 501]);
    });
  },
);

flow("CONN-9", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/pipedream/apps"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("pipedream catalog → 200 or 501", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/pipedream/apps", { params: { projectId: p.id } });
    r.status([200, 501]);
  });
});

flow(
  "CONN-15",
  {
    domain: "connectors",
    routes: [
      "GET /v1/executor/projects/:projectId/discover/integrations",
      "GET /v1/executor/projects/:projectId/discover/integrations/detail",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("project admin browses the direct catalogue", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/executor/projects/:projectId/discover/integrations", {
          params: { projectId: p.id },
          query: { q: "HubSpot" },
        });
      r.status([200, 502]);
      if (r.statusCode !== 200) return;
      r.body().exists("$.items").exists("$.total").exists("$.hasMore");
      const firstId = r.json<{ items?: Array<{ id?: string }> }>().items?.[0]?.id;
      if (!firstId) return;
      const detail = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/executor/projects/:projectId/discover/integrations/detail", {
          params: { projectId: p.id },
          query: { id: firstId },
        });
      detail.status(200).body().exists("$.item").exists("$.variants");
    });
    await ctx.step("NONMEMBER cannot browse or resolve catalogue records", async () => {
      const list = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/executor/projects/:projectId/discover/integrations", {
          params: { projectId: p.id },
        });
      list.status(403);
      const detail = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/executor/projects/:projectId/discover/integrations/detail", {
          params: { projectId: p.id },
          query: { id: "openapi/example" },
        });
      detail.status(403);
    });
  },
);

flow("CONN-12", { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/connectors/:slug/config"] }, async (ctx) => {
  const p = await ctx.fixtures.project();
  await ctx.step("unknown connector → 404", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/executor/projects/:projectId/connectors/:slug/config", { params: { projectId: p.id, slug: "nope" } });
    r.status([404, 501]);
  });
  await ctx.step("NONMEMBER → 403", async () => {
    const r = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/executor/projects/:projectId/connectors/:slug/config", { params: { projectId: p.id, slug: "nope" } });
    r.status(403);
  });
});

// Admin: connector-policy mutations — credential mode, display name, and the
// per-tool/per-pattern call policies. All three gate on project.connector.write
// (resolveAdmin), validate their body BEFORE looking up the connector (so an
// invalid mode/name/policy is a 400 even against an unknown slug), and 404 an
// unknown connector once the body is well-formed.
flow(
  "CONN-13",
  {
    domain: "connectors",
    routes: [
      "PUT /v1/executor/projects/:projectId/connectors/:slug/credential-mode",
      "PUT /v1/executor/projects/:projectId/connectors/:slug/name",
      "PUT /v1/executor/projects/:projectId/connectors/:slug/policies",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("credential-mode: invalid mode → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/credential-mode", { mode: "nope" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(400);
    });
    await ctx.step("credential-mode: valid mode but unknown connector → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/credential-mode", { mode: "shared" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(404);
    });

    await ctx.step("name: empty name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/name", { name: "" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(400);
    });
    await ctx.step("name: valid name but unknown connector → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/name", { name: "Renamed" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(404);
    });

    await ctx.step("policies: not an array → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/policies", { policies: "nope" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(400);
    });
    await ctx.step("policies: invalid action validated before the connector lookup → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/executor/projects/:projectId/connectors/:slug/policies",
          { policies: [{ match: "foo", action: "nope" }] },
          { params: { projectId: p.id, slug: "nope" } },
        );
      r.status(400);
    });
    await ctx.step("policies: well-formed but unknown connector → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/policies", { policies: [] }, { params: { projectId: p.id, slug: "nope" } });
      r.status(404);
    });

    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/executor/projects/:projectId/connectors/:slug/credential-mode", { mode: "shared" }, { params: { projectId: p.id, slug: "nope" } });
      r.status(403);
    });
  },
);

flow(
  "CONN-14",
  {
    domain: "connectors",
    routes: ["POST /v1/executor/projects/:projectId/connectors/auth-discovery"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step("source with no location returns an empty discovery", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/executor/projects/:projectId/connectors/auth-discovery",
          { provider: "openapi" },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.status", "none")
        .has("$.recommended", null)
        .has("$.totalRequests", 0);
    });

    await ctx.step("NONMEMBER cannot inspect connector authentication", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/executor/projects/:projectId/connectors/auth-discovery",
          { provider: "openapi" },
          { params: { projectId: p.id } },
        );
      r.status(403);
    });
  },
);

// Pairs with CONN-7 (PUT .../credential) — disconnect (delete) a connector's
// stored credential. Unknown connector → 404 (deleteConnectorCredential looks
// the connector up before touching the credential store).
flow(
  "CONN-16",
  { domain: "connectors", routes: ["DELETE /v1/executor/projects/:projectId/connectors/:slug/credential"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("delete credential for an unknown connector → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/executor/projects/:projectId/connectors/:slug/credential", { params: { projectId: p.id, slug: "nope" } });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/executor/projects/:projectId/connectors/:slug/credential", { params: { projectId: p.id, slug: "nope" } });
      r.status(403);
    });
  },
);

// Pairs with CONN-13 (PUT .../policies) — read a connector's per-tool/per-pattern
// policies. Unknown connector → 404 (manifest-first, DB-fallback; neither hits).
flow(
  "CONN-17",
  { domain: "connectors", routes: ["GET /v1/executor/projects/:projectId/connectors/:slug/policies"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("read policies for an unknown connector → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/executor/projects/:projectId/connectors/:slug/policies", { params: { projectId: p.id, slug: "nope" } });
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/executor/projects/:projectId/connectors/:slug/policies", { params: { projectId: p.id, slug: "nope" } });
      r.status(403);
    });
  },
);

// Connector-profiles — mint→activate→credential→revoke lifecycle. Creating a
// real profile needs an existing executor connector to reference by
// connector_alias, so this first declares a lightweight `mcp` connector (only
// requires a `url`, no live reachability check during manifest sync) via the
// already-covered POST /v1/executor/projects/:projectId/connectors, then drives
// the full connector-profiles surface against it.
flow(
  "COVD-1",
  {
    domain: "connectors",
    routes: [
      "GET /v1/projects/:projectId/connector-profiles",
      "POST /v1/projects/:projectId/connector-profiles",
      "PUT /v1/projects/:projectId/connector-profiles/:profileId/activate",
      "PUT /v1/projects/:projectId/connector-profiles/:profileId/credential",
      "PUT /v1/projects/:projectId/connector-profiles/:profileId/revoke",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const slug = `ke2e-mcp-${Date.now().toString(36)}`;

    await ctx.step("seed a real connector to hang a profile off (mcp provider)", async () => {
      // auth explicitly set (not omitted) so the create route skips its
      // auto-discovery probe — that probe does a LIVE fetch against the
      // connector's url, and this url is intentionally unreachable.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/executor/projects/:projectId/connectors",
          { slug, provider: "mcp", url: "https://ke2e.kortix.test/mcp", auth: { type: "none" } },
          { params: { projectId: p.id } },
        );
      r.status(200).body().has("$.ok", true);
    });

    await ctx.step("list connector-profiles → 200, empty before any profile exists", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/connector-profiles", { params: { projectId: p.id } });
      r.status(200).body().exists("$.profiles");
    });

    await ctx.step("NONMEMBER cannot list → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/connector-profiles", { params: { projectId: p.id } });
      r.status([403, 404]);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/connector-profiles", { params: { projectId: p.id } });
      r.status(401);
    });

    let profileId = "";
    await ctx.step("create (reconcile) a connection profile → 201 with a real shape", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/connector-profiles",
          { connector_alias: slug, owner_type: "external", owner_id: "ke2e-external-owner-1", label: "KE2E connection" },
          { params: { projectId: p.id } },
        );
      r.status(201)
        .body()
        .has("$.connector_alias", slug)
        .has("$.owner_type", "external")
        .has("$.status", "active")
        .exists("$.profile_id");
      profileId = r.json<any>().profile_id;
    });

    await ctx.step("missing required fields → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/connector-profiles", { connector_alias: slug }, { params: { projectId: p.id } });
      r.status(400);
    });

    await ctx.step("activate the profile → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/connector-profiles/:profileId/activate", {}, { params: { projectId: p.id, profileId } });
      r.status(200).body().has("$.ok", true);
    });

    await ctx.step("set the profile's credential → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/connector-profiles/:profileId/credential",
          { value: "ke2e-secret-value" },
          { params: { projectId: p.id, profileId } },
        );
      r.status(200).body().has("$.ok", true);
    });

    await ctx.step("credential with no value → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/connector-profiles/:profileId/credential", {}, { params: { projectId: p.id, profileId } });
      r.status(400);
    });

    await ctx.step("revoke the profile (terminal state — no DELETE route exists) → 200 ok", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/connector-profiles/:profileId/revoke", {}, { params: { projectId: p.id, profileId } });
      r.status(200).body().has("$.ok", true);
    });

    await ctx.step("activate/credential/revoke on an unknown profileId → 404", async () => {
      const unknown = "00000000-0000-4000-a000-000000000000";
      for (const op of ["activate", "credential", "revoke"] as const) {
        const body = op === "credential" ? { value: "x" } : {};
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .put(`/v1/projects/:projectId/connector-profiles/:profileId/${op}`, body, { params: { projectId: p.id, profileId: unknown } });
        r.status(404);
      }
    });
  },
);

// Setup-links (connector half) — public, token-gated read + start. The minting
// side (POST /v1/projects/:projectId/connect-requests) belongs to a different
// coverage group; this covers the two public consume-side routes independently
// via the boundary case (a bogus token can never resolve, regardless of who
// eventually mints real ones), which is legitimate coverage on its own.
flow(
  "COVD-2",
  {
    domain: "connectors",
    routes: ["GET /v1/setup-links/connector/:token", "POST /v1/setup-links/connector/:token/start"],
  },
  async (ctx) => {
    await ctx.step("GET with a bogus token → 404 (invalid/unknown link)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/setup-links/connector/:token", { params: { token: "bogus-connector-setup-link" } });
      r.status(404).body().exists("$.error");
    });
    await ctx.step("POST .../start with a bogus token → 404 (invalid/unknown link)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/setup-links/connector/:token/start", {}, { params: { token: "bogus-connector-setup-link" } });
      r.status(404).body().exists("$.error");
    });
  },
);

// CONN-18 — mint a Pipedream Quick Connect setup link (projects/routes/setup-links.ts).
// The real 200 needs a live Pipedream-backed connector already declared in
// kortix.yaml (which a bare e2e project has none of), so this covers the real
// validation boundary: missing slug → 400; a slug that names no connected-via-
// Pipedream connector on this project → 404 (or 501 if Pipedream isn't
// configured on this deployment at all — both are legitimate real outcomes,
// never a 200/201 without a real connector). The analogous public consume
// routes (`GET/POST /v1/setup-links/connector/:token[/start]`, COVD-2 above)
// belong to a different coverage group.
flow(
  "CONN-18",
  { domain: "connectors", routes: ["POST /v1/projects/:projectId/connect-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("missing slug → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/connect-requests", {}, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("unconnected slug → 404 (or 501 if Pipedream isn't configured)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/connect-requests",
          { slug: "not-a-connected-app" },
          { params: { projectId: p.id } },
        );
      r.status([404, 501]);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/connect-requests",
          { slug: "not-a-connected-app" },
          { params: { projectId: p.id } },
        );
      r.status([403, 404]);
    });
  },
);
