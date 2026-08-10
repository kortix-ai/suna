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

    await ctx.step("system KORTIX_* secret cannot be deleted → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/secrets/:name", { params: { projectId: p.id, name: "KORTIX_TOKEN" } });
      r.status(403);
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

flow(
  "SEC-8",
  {
    domain: "secrets",
    routes: [
      "POST /v1/projects/:projectId/secrets",
      "GET /v1/projects/:projectId/secrets",
      "PUT /v1/projects/:projectId/secrets/:identifier/strategy",
      "POST /v1/projects/:projectId/secrets/:identifier/broker",
      "POST /v1/projects/:projectId/secrets/sync",
      "GET /v1/accounts/:accountId/audit",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const p = await team.project();
    let networkBoundaryAvailable = false;

    await ctx.step("create returns explicit runtime delivery metadata", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "CONTROL_PLANE_KEY", value: "control-plane-value" },
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "runtime")
        .has("$.consumer", "sandbox")
        .has("$.delivery_status", "available")
        .has("$.requires_rotation", false);
      networkBoundaryAvailable = r.json<{ network_boundary_available?: boolean }>().network_boundary_available === true;
    });

    await ctx.step("manager disables sandbox delivery", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "denied" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "denied")
        .has("$.consumer", null)
        .has("$.delivery_status", "disabled")
        .has("$.requires_rotation", true);
    });

    await ctx.step("manager synchronizes the current policy to active sessions", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/sync",
          {},
          { params: { projectId: p.id } },
        );
      r.status(200)
        .body()
        .has("$.ok", true)
        .has("$.active_sandboxes", 0)
        .has("$.targeted", 0)
        .has("$.synced", 0)
        .has("$.failed", 0)
        .has("$.exported", 0)
        .has("$.results", []);
    });

    await ctx.step("runtime delivery stays disabled until rotation", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "runtime" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(409).body().has("$.code", "secret_rotation_required");
    });

    await ctx.step("broker delivery requires an outbound policy", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "broker" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(400).body().has("$.code", "secret_delivery_policy_required");
    });

    await ctx.step("generic HTTPS broker accepts a validated policy", async () => {
      const policy = {
        backend: "kortix_fetch",
        rules: [{ host: "api.example.com", methods: ["POST"], path: "/v1/*" }],
        inject: { kind: "header", name: "authorization", template: "Bearer {{secret}}" },
      };
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "broker", egress_policy: policy, handle_prefix: "svc_" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(200)
        .body()
        .has("$.strategy", "broker")
        .has("$.consumer", "http_broker")
        .has("$.delivery_status", "available")
        .has("$.egress_policy", policy);
    });

    await ctx.step("transparent egress follows the deployment capability", async () => {
      const policy = {
        rules: [{ host: "api.example.com" }],
        inject: { kind: "header", name: "authorization", template: "Bearer {{secret}}" },
      };
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: policy,
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      if (networkBoundaryAvailable) {
        r.status(200)
          .body()
          .has("$.strategy", "egress")
          .has("$.consumer", "network")
          .has("$.delivery_status", "available")
          .has("$.egress_policy", policy);
      } else {
        r.status(409).body().has("$.code", "secret_delivery_unavailable");
      }
    });

    await ctx.step("transparent egress rejects controls the provider cannot enforce", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          {
            strategy: "egress",
            egress_policy: {
              rules: [{ host: "api.example.com", methods: ["POST"] }],
              inject: { kind: "header", name: "authorization" },
            },
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(400).body().has("$.code", "secret_delivery_policy_invalid");
    });

    await ctx.step("broker execution requires a session-scoped agent token", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets/:identifier/broker",
          {
            url: "https://api.example.com/v1/messages",
            method: "POST",
            body_base64: "e30=",
          },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      r.status(403).body().has("$.code", "session_agent_token_required");
    });

    await ctx.step("rotation permits runtime delivery", async () => {
      const rotate = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "CONTROL_PLANE_KEY", value: "rotated-control-plane-value" },
          { params: { projectId: p.id } },
        );
      rotate
        .status(200)
        .body()
        .has("$.strategy", networkBoundaryAvailable ? "egress" : "broker")
        .has("$.requires_rotation", false);

      const restore = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/secrets/:identifier/strategy",
          { strategy: "runtime" },
          { params: { projectId: p.id, identifier: "CONTROL_PLANE_KEY" } },
        );
      restore
        .status(200)
        .body()
        .has("$.strategy", "runtime")
        .has("$.requires_rotation", false);
    });

    await ctx.step("central audit reconstructs the strategy change without a value", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit", {
        params: { accountId: team.id },
        query: { project_id: p.id, action: "secret.strategy.changed" },
      });
      r.status(200).body().exists("$.events[0]");
      const events = r.json<{ events: Array<Record<string, unknown>> }>().events;
      const matchingEvents = events.filter((item) => item.action === "secret.strategy.changed");
      const event = matchingEvents[0];
      if (!event || matchingEvents.length < 3) throw new Error("strategy audit events missing");
      if (
        event.project_id !== p.id ||
        event.resource_type !== "project_secret" ||
        JSON.stringify(matchingEvents).includes("control-plane-value")
      ) {
        throw new Error(`unsafe strategy audit event: ${JSON.stringify(event)}`);
      }
    });
  },
);

flow(
  "CONN-ATT-AUTH",
  {
    domain: "secrets",
    routes: [
      "POST /v1/connectors/attachments",
      "POST /v1/connectors/projects/:projectId/attachments",
    ],
  },
  async (ctx) => {
    await ctx.step("anonymous attachment upload is rejected", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/connectors/attachments", {});
      r.status(401);
    });

    await ctx.step("anonymous project attachment upload is rejected", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/connectors/projects/:projectId/attachments",
          {},
          { params: { projectId: "00000000-0000-4000-a000-000000000000" } },
        );
      r.status(401);
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
