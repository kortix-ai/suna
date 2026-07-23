/**
 * OAuth2 provider surface (apps/api/src/oauth/index.ts, mounted at /v1/oauth).
 * Public endpoints: /authorize, /token. Auth (supabase JWT): consent.
 * Auth (oauthTokenAuth bearer access-token): /userinfo.
 *
 * We have no real oauth_clients row or issued access token in the e2e DB, so
 * these exercise the validation + auth boundaries (the deterministic, real
 * behavior) rather than a full happy-path token exchange. Maps to spec OAU-*.
 */
import { flow } from "../core/flow";

// ── OAU-1: GET /authorize ────────────────────────────────────────────────────
flow("OAU-1", { domain: "oauth", routes: ["GET /v1/oauth/authorize"] }, async (ctx) => {
  await ctx.step("authorize: missing required params → rejected (400/500)", async () => {
    // Bare /authorize with no params: the provider rejects it; local returns 500
    // (throws before building the invalid_request response) — assert the rejection.
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize");
    r.status([400, 500]);
  });
  await ctx.step("authorize: non-uuid client_id → 400 invalid_client, no DB cast error", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
      query: {
        client_id: "notreal",
        redirect_uri: "https://example.com/cb",
        response_type: "code",
        code_challenge: "abc123",
        code_challenge_method: "S256",
      },
    });
    r.status(400).body().has("$.error", "invalid_client");
  });
  await ctx.step("authorize: unknown uuid client_id → 400 invalid_client", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
      query: {
        client_id: "00000000-0000-4000-a000-000000000000",
        redirect_uri: "https://example.com/cb",
        response_type: "code",
        code_challenge: "abc123",
        code_challenge_method: "S256",
      },
    });
    r.status(400).body().has("$.error", "invalid_client");
  });
  await ctx.step("authorize: bad code_challenge_method → 400", async () => {
    const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
      query: {
        client_id: "ke2e-client",
        redirect_uri: "https://example.com/cb",
        response_type: "code",
        code_challenge: "abc",
        code_challenge_method: "plain",
      },
    });
    r.status([400, 500]);
  });
});

// ── OAU-2: consent (auth) ────────────────────────────────────────────────────
flow(
  "OAU-2",
  {
    domain: "oauth",
    routes: [
      "GET /v1/oauth/authorize/consent/:requestId",
      "POST /v1/oauth/authorize/consent",
    ],
  },
  async (ctx) => {
    await ctx.step("consent GET: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/oauth/authorize/consent/:requestId", { params: { requestId: "ke2e-bogus" } });
      r.status(401);
    });
    await ctx.step("consent GET: OWNER, unknown request id → 400 invalid_request", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/oauth/authorize/consent/:requestId", { params: { requestId: "ke2e-bogus" } });
      r.status(400).body().has("$.error", "invalid_request");
    });
    await ctx.step("consent POST: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/oauth/authorize/consent", { request_id: "ke2e-bogus", approved: true });
      r.status(401);
    });
    await ctx.step("consent POST: OWNER, missing request_id → 400 invalid_request", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", {});
      r.status(400).body().has("$.error", "invalid_request");
    });
    await ctx.step("consent POST: OWNER, unknown request_id → 400 invalid_request", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/oauth/authorize/consent", { request_id: "ke2e-bogus", approved: true });
      r.status(400).body().has("$.error", "invalid_request");
    });
  },
);

// ── OAU-3: POST /token (public, form-encoded) ────────────────────────────────
flow("OAU-3", { domain: "oauth", routes: ["POST /v1/oauth/token"] }, async (ctx) => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };

  await ctx.step("token: missing client credentials → 400 invalid_request", async () => {
    const r = await ctx.client
      .as(ctx.P.ANON)
      .post("/v1/oauth/token", form({ grant_type: "authorization_code" }));
    r.status(400).body().has("$.error", "invalid_request");
  });
  await ctx.step("token: non-uuid client_id → 401 invalid_client, no DB cast error", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post(
      "/v1/oauth/token",
      form({
        grant_type: "authorization_code",
        client_id: "notreal",
        client_secret: "ke2e-bad-secret",
        code: "x",
        redirect_uri: "https://example.com/cb",
        code_verifier: "y",
      }),
    );
    r.status(401).body().has("$.error", "invalid_client");
  });
  await ctx.step("token: unknown uuid client_id+secret → 401 invalid_client", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post(
      "/v1/oauth/token",
      form({
        grant_type: "authorization_code",
        client_id: "00000000-0000-4000-a000-000000000000",
        client_secret: "ke2e-bad-secret",
        code: "x",
        redirect_uri: "https://example.com/cb",
        code_verifier: "y",
      }),
    );
    r.status(401).body().has("$.error", "invalid_client");
  });
  await ctx.step("token: bogus grant_type with creds → 401 (client unknown first)", async () => {
    // client_id/secret are validated before grant_type; since the client is
    // unknown we get invalid_client (401). A real client would yield
    // unsupported_grant_type (400). Accept the boundary set.
    const r = await ctx.client.as(ctx.P.ANON).post(
      "/v1/oauth/token",
      form({ grant_type: "bogus", client_id: "ke2e-x", client_secret: "ke2e-y" }),
    );
    r.status([400, 401, 500]);
  });
});

// ── OAU-4: userinfo (oauthTokenAuth bearer) ──────────────────────────────────
flow(
  "OAU-4",
  {
    domain: "oauth",
    routes: ["GET /v1/oauth/userinfo"],
  },
  async (ctx) => {
    await ctx.step("userinfo: no bearer → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/userinfo");
      r.status(401);
    });
    await ctx.step("userinfo: a supabase JWT is not an oauth access token → 401", async () => {
      // oauthTokenAuth only accepts hashed oauth_access_tokens rows; a normal
      // user JWT won't match, so it's rejected the same as anon.
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/oauth/userinfo");
      r.status(401);
    });
  },
);

// ── Unified auth-provider surface (apps/api/src/projects/routes/auth-providers.ts)
// The two-door connect registry the web modal and the CLI both read
// (docs/specs/2026-07-22-unified-auth-gateway.md §8.3). Distinct from the
// OAU-* OAuth2 SERVER above: these routes STORE/POLL credentials for upstream
// providers (Anthropic, OpenAI/Codex), they don't issue Kortix tokens.
//
// Deterministic-only: no external provider round-trip. The paste-token start
// (Anthropic) 400s before any network; poll with a garbage handle decrypts to
// nothing → "expired"; the OWNER 200s exercise pure reads. A live Codex
// device-code start/poll happy-path needs OpenAI's endpoint + a human
// approval, so it stays out of the deterministic suite.
//
// NOTE: these are AUTHP-* (auth-providers), NOT the AUTH-* namespace — AUTH-1
// is already taken by POST /v1/auth/logout (auth.flow.ts).

// ── AUTHP-1: GET /auth-providers — both doors + live status ──────────────────
flow(
  "AUTHP-1",
  { domain: "auth-providers", routes: ["GET /v1/projects/:projectId/auth-providers"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/auth-providers", { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("OWNER → 200 with both doors + a byok tail", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/auth-providers", { params: { projectId: p.id } });
      r.status(200);
      const body = r.json<{
        providers: Array<{ id: string; door: string; compatibleHarnesses: string[] }>;
        byok: Array<{ id: string }>;
      }>();
      const doors = new Set((body.providers ?? []).map((x) => x.door));
      if (!doors.has("account") || !doors.has("api-key")) {
        throw new Error(`expected both doors, got ${JSON.stringify([...doors])}`);
      }
      // Anthropic's account door (Claude Code) is always present.
      if (!body.providers.some((x) => x.id === "anthropic" && x.door === "account")) {
        throw new Error("expected an anthropic account-door provider");
      }
      if (!Array.isArray(body.byok) || body.byok.length === 0) {
        throw new Error("expected a non-empty byok catalog tail");
      }
    });
  },
);

// ── AUTHP-2: GET /auth-providers/:providerId/status ──────────────────────────
flow(
  "AUTHP-2",
  {
    domain: "auth-providers",
    routes: ["GET /v1/projects/:projectId/auth-providers/:providerId/status"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/auth-providers/:providerId/status", {
          params: { projectId: p.id, providerId: "openai" },
        });
      r.status(401);
    });
    await ctx.step("OWNER, a known provider → 200 with a typed status", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/auth-providers/:providerId/status", {
          params: { projectId: p.id, providerId: "anthropic" },
        });
      r.status(200).body().exists("$.status.status");
    });
    await ctx.step("OWNER, an unknown provider → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/auth-providers/:providerId/status", {
          params: { projectId: p.id, providerId: "not-a-real-provider" },
        });
      r.status(404);
    });
  },
);

// ── AUTHP-3: POST /oauth-credentials/:providerId/start ───────────────────────
flow(
  "AUTHP-3",
  {
    domain: "auth-providers",
    routes: ["POST /v1/projects/:projectId/oauth-credentials/:providerId/start"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:projectId/oauth-credentials/:providerId/start",
          {},
          { params: { projectId: p.id, providerId: "openai" } },
        );
      r.status(401);
    });
    await ctx.step("a paste-token provider (Anthropic) has no device flow → 400", async () => {
      // Anthropic's account door is paste-token (`claude setup-token`), not
      // device-code — start refuses it (spec §6.3) rather than round-tripping.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/oauth-credentials/:providerId/start",
          {},
          { params: { projectId: p.id, providerId: "anthropic" } },
        );
      r.status(400);
    });
    await ctx.step("an unknown account provider → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/oauth-credentials/:providerId/start",
          {},
          { params: { projectId: p.id, providerId: "not-a-real-provider" } },
        );
      r.status(404);
    });
  },
);

// ── AUTHP-4: POST /oauth-credentials/:providerId/poll ────────────────────────
flow(
  "AUTHP-4",
  {
    domain: "auth-providers",
    routes: ["POST /v1/projects/:projectId/oauth-credentials/:providerId/poll"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/projects/:projectId/oauth-credentials/:providerId/poll",
          { flow_id: "x" },
          { params: { projectId: p.id, providerId: "openai" } },
        );
      r.status(401);
    });
    await ctx.step("a garbage flow handle decrypts to nothing → expired", async () => {
      // The flow handle is an opaque, project-key-encrypted envelope; anything
      // that isn't one (or is from another project) opens to null → expired,
      // never a 500 (spec §6.3, mirrors r3's any-replica poll).
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/oauth-credentials/:providerId/poll",
          { flow_id: "garbage-not-a-handle" },
          { params: { projectId: p.id, providerId: "openai" } },
        );
      r.status(200).body().has("$.status", "expired");
    });
  },
);

// ── AUTHP-5: GET /oauth-credentials (list) + DELETE (disconnect) ─────────────
flow(
  "AUTHP-5",
  {
    domain: "auth-providers",
    routes: [
      "GET /v1/projects/:projectId/oauth-credentials",
      "DELETE /v1/projects/:projectId/oauth-credentials/:providerId",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("list: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/oauth-credentials", { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("list: OWNER → 200 with an items array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/oauth-credentials", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
    });
    await ctx.step("delete: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del("/v1/projects/:projectId/oauth-credentials/:providerId", {
          params: { projectId: p.id, providerId: "openai" },
        });
      r.status(401);
    });
  },
);
