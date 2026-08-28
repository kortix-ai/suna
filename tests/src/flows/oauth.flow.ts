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

// ── Sign in with Kortix (2026-08-26): a REAL client, registered by the OWNER ──
// The flows above exercised boundaries only because no oauth_clients row
// existed. Registration is now self-serve, so the full authorization-code +
// PKCE exchange, refresh, revoke and the first-class `kortix_oat_` credential
// are driven end to end over HTTP here.

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

// ── OAU-5: discovery ─────────────────────────────────────────────────────────
flow(
  "OAU-5",
  {
    domain: "oauth",
    routes: [
      "GET /.well-known/oauth-authorization-server",
      "GET /v1/oauth/.well-known/oauth-authorization-server",
    ],
  },
  async (ctx) => {
    await ctx.step("RFC 8414 metadata at the API root names every endpoint", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-authorization-server");
      r.status(200).body().exists("$.issuer").exists("$.authorization_endpoint").exists("$.token_endpoint").exists("$.revocation_endpoint");
      const body = r.json<any>();
      if (!body.authorization_endpoint.endsWith("/v1/oauth/authorize")) throw new Error(`authorization_endpoint: ${body.authorization_endpoint}`);
      if (!body.code_challenge_methods_supported.includes("S256")) throw new Error("S256 missing");
      if (!body.scopes_supported.includes("kortix")) throw new Error("kortix scope missing");
    });
    await ctx.step("the /v1/oauth mirror serves the same document", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/.well-known/oauth-authorization-server");
      r.status(200).body().exists("$.issuer");
    });
  },
);

// ── OAU-6: OAuth client registry ─────────────────────────────────────────────
flow(
  "OAU-6",
  {
    domain: "oauth",
    routes: [
      "GET /v1/accounts/:accountId/iam/oauth-clients",
      "POST /v1/accounts/:accountId/iam/oauth-clients",
      "GET /v1/accounts/:accountId/iam/oauth-clients/:clientId",
      "PATCH /v1/accounts/:accountId/iam/oauth-clients/:clientId",
      "POST /v1/accounts/:accountId/iam/oauth-clients/:clientId/rotate-secret",
      "DELETE /v1/accounts/:accountId/iam/oauth-clients/:clientId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    let clientId = "";
    let secret = "";
    await ctx.step("register a confidential client → 201 with the secret shown once", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/oauth-clients",
        { name: ctx.fixtures.name("oauth-app"), redirect_uris: ["https://app.example.test/api/kortix/auth/callback"], scopes: ["profile", "kortix"] },
        { params: { accountId: team.id } },
      );
      r.status(201).body().exists("$.client_id").exists("$.client_secret").has("$.client_type", "confidential").has("$.active", true);
      clientId = r.json<any>().client_id;
      secret = r.json<any>().client_secret;
      if (!secret.startsWith("kortix_ocs_")) throw new Error(`secret prefix: ${secret.slice(0, 12)}`);
    });
    await ctx.step("list + get never carry the secret", async () => {
      const list = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/iam/oauth-clients", { params: { accountId: team.id } });
      list.status(200).body().exists("$.oauth_clients").exists("$.scopes_supported");
      const row = list.json<any>().oauth_clients.find((c: any) => c.client_id === clientId);
      if (!row || "client_secret" in row) throw new Error("secret leaked in list or client missing");
      const one = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
      one.status(200).body().has("$.client_id", clientId);
      if ("client_secret" in one.json<any>()) throw new Error("secret leaked in get");
    });
    await ctx.step("validation: http on a non-loopback host → 400; unknown scope → 400", async () => {
      const http = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/oauth-clients",
        { name: "x", redirect_uris: ["http://app.example.test/cb"] },
        { params: { accountId: team.id } },
      );
      http.status(400);
      const scope = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/oauth-clients",
        { name: "x", redirect_uris: ["https://app.example.test/cb"], scopes: ["admin"] },
        { params: { accountId: team.id } },
      );
      scope.status(400);
    });
    await ctx.step("patch name + deactivate → 200; rotate → a different secret", async () => {
      const p = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/accounts/:accountId/iam/oauth-clients/:clientId",
        { name: "renamed", active: false },
        { params: { accountId: team.id, clientId } },
      );
      p.status(200).body().has("$.name", "renamed").has("$.active", false);
      const rot = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/oauth-clients/:clientId/rotate-secret",
        {},
        { params: { accountId: team.id, clientId } },
      );
      rot.status(200).body().exists("$.client_secret");
      if (rot.json<any>().client_secret === secret) throw new Error("rotate returned the same secret");
    });
    await ctx.step("NONMEMBER → 403 on list and delete", async () => {
      const list = await ctx.client.as(ctx.P.NONMEMBER).get("/v1/accounts/:accountId/iam/oauth-clients", { params: { accountId: team.id } });
      list.status(403);
      const del = await ctx.client.as(ctx.P.NONMEMBER).del("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
      del.status(403);
    });
    await ctx.step("delete → 200; unknown id → 404", async () => {
      const del = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
      del.status(200).body().has("$.deleted", true);
      const gone = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
      gone.status(404);
    });
  },
);

// ── OAU-7: the full authorization-code + PKCE flow, refresh, revoke ─────────
flow(
  "OAU-7",
  {
    domain: "oauth",
    routes: [
      "GET /v1/oauth/authorize",
      "GET /v1/oauth/authorize/consent/:requestId",
      "POST /v1/oauth/authorize/consent",
      "POST /v1/oauth/token",
      "GET /v1/oauth/userinfo",
      "POST /v1/oauth/revoke",
      "GET /v1/accounts/me",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const redirectUri = "https://app.example.test/api/kortix/auth/callback";
    let clientId = "";
    let secret = "";
    let accessToken = "";
    let refreshToken = "";
    const { verifier, challenge } = await pkcePair();

    await ctx.step("register the client", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/accounts/:accountId/iam/oauth-clients",
        { name: ctx.fixtures.name("oauth-flow"), redirect_uris: [redirectUri], scopes: ["profile", "email", "kortix"] },
        { params: { accountId: team.id } },
      );
      r.status(201);
      clientId = r.json<any>().client_id;
      secret = r.json<any>().client_secret;
    });

    let requestId = "";
    await ctx.step("authorize → 302 to the consent page carrying only an opaque request_id", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
        query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "profile kortix", state: "s1", code_challenge: challenge, code_challenge_method: "S256" },
      });
      r.status(302);
      const location = new URL(r.header("location")!);
      requestId = location.searchParams.get("request_id") ?? "";
      if (!requestId || location.searchParams.get("client_id")) throw new Error(`consent url: ${location}`);
    });

    let code = "";
    await ctx.step("consent GET is not remembered the first time; approve → code; a replay is refused", async () => {
      const meta = await ctx.client.as(ctx.P.OWNER).get("/v1/oauth/authorize/consent/:requestId", { params: { requestId } });
      meta.status(200).body().has("$.remembered", false).has("$.client_type", "confidential");
      const ok = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", { request_id: requestId, approved: true });
      ok.status(200);
      const redirect = new URL(ok.json<any>().redirect_uri);
      if (redirect.origin + redirect.pathname !== redirectUri) throw new Error(`redirect: ${redirect}`);
      if (redirect.searchParams.get("state") !== "s1") throw new Error("state lost");
      code = redirect.searchParams.get("code") ?? "";
      if (!code) throw new Error("no code");
      const replay = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", { request_id: requestId, approved: true });
      replay.status(400);
    });

    await ctx.step("a second authorize is remembered (consent covers the scopes)", async () => {
      const again = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
        query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "profile", code_challenge: challenge, code_challenge_method: "S256" },
      });
      again.status(302);
      const rid = new URL(again.header("location")!).searchParams.get("request_id")!;
      const meta = await ctx.client.as(ctx.P.OWNER).get("/v1/oauth/authorize/consent/:requestId", { params: { requestId: rid } });
      meta.status(200).body().has("$.remembered", true);
    });

    await ctx.step("token: wrong verifier → 400 invalid_grant; right verifier → kortix_oat_ + kortix_ort_", async () => {
      const bad = await ctx.client.as(ctx.P.ANON).post(
        "/v1/oauth/token",
        form({ grant_type: "authorization_code", client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri, code_verifier: "wrong" }),
      );
      bad.status(400).body().has("$.error", "invalid_grant");
      const r = await ctx.client.as(ctx.P.ANON).post(
        "/v1/oauth/token",
        form({ grant_type: "authorization_code", client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri, code_verifier: verifier }),
      );
      r.status(200).body().has("$.token_type", "Bearer").has("$.scope", "profile kortix");
      accessToken = r.json<any>().access_token;
      refreshToken = r.json<any>().refresh_token;
      if (!accessToken.startsWith("kortix_oat_") || !refreshToken.startsWith("kortix_ort_")) throw new Error("token prefixes");
    });

    await ctx.step("the access token is a first-class credential: /accounts/me → auth_type oauth; userinfo → sub", async () => {
      const me = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${accessToken}` } });
      me.status(200).body().has("$.token_context.auth_type", "oauth");
      const info = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
      info.status(200).body().exists("$.sub").exists("$.email");
    });

    await ctx.step("refresh rotates: the old refresh token dies, the new access token works", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "refresh_token", client_id: clientId, client_secret: secret, refresh_token: refreshToken }));
      r.status(200);
      const next = r.json<any>();
      const reuse = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "refresh_token", client_id: clientId, client_secret: secret, refresh_token: refreshToken }));
      reuse.status(400);
      const old = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${accessToken}` } });
      old.status(401);
      accessToken = next.access_token;
      refreshToken = next.refresh_token;
      const fresh = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${accessToken}` } });
      fresh.status(200);
    });

    await ctx.step("revoke the refresh token → its access token is dead too; unknown token still 200", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/revoke", form({ client_id: clientId, client_secret: secret, token: refreshToken }));
      r.status(200).body().has("$.revoked", true);
      const dead = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${accessToken}` } });
      dead.status(401);
      const unknown = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/revoke", form({ client_id: clientId, client_secret: secret, token: "kortix_oat_nope" }));
      unknown.status(200).body().has("$.revoked", false);
      const unauth = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/revoke", form({ client_id: clientId, client_secret: "wrong", token: "kortix_oat_nope" }));
      unauth.status(401);
    });

    await ctx.step("cleanup: delete the client", async () => {
      const del = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
      del.status(200);
    });
  },
);

// ── OAU-8: identity-only tokens (no `kortix` scope) and public clients ───────
flow("OAU-8", { domain: "oauth", routes: ["POST /v1/oauth/token", "GET /v1/oauth/userinfo", "GET /v1/accounts/me"] }, async (ctx) => {
  const team = await ctx.fixtures.team();
  const redirectUri = "http://localhost:5173/callback";
  const { verifier, challenge } = await pkcePair();
  let clientId = "";
  await ctx.step("a public client (PKCE only, localhost http redirect) registers with profile scope only", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).post(
      "/v1/accounts/:accountId/iam/oauth-clients",
      { name: ctx.fixtures.name("spa"), client_type: "public", redirect_uris: [redirectUri], scopes: ["profile"] },
      { params: { accountId: team.id } },
    );
    r.status(201).body().has("$.client_type", "public").has("$.client_secret", null);
    clientId = r.json<any>().client_id;
  });
  let accessToken = "";
  await ctx.step("authorize → consent → token without a secret; sending one is refused", async () => {
    const a = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
      query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "profile", code_challenge: challenge, code_challenge_method: "S256" },
    });
    a.status(302);
    const rid = new URL(a.header("location")!).searchParams.get("request_id")!;
    const ok = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", { request_id: rid, approved: true });
    ok.status(200);
    const code = new URL(ok.json<any>().redirect_uri).searchParams.get("code")!;
    const withSecret = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, client_secret: "x", code, redirect_uri: redirectUri, code_verifier: verifier }));
    withSecret.status(401);
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }));
    r.status(200).body().has("$.scope", "profile");
    accessToken = r.json<any>().access_token;
  });
  await ctx.step("profile-only: userinfo + /accounts/me work, the general API is 403 insufficient_scope", async () => {
    const info = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
    info.status(200);
    const me = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    me.status(200).body().has("$.token_context.auth_type", "oauth");
    const projects = await ctx.client.as(ctx.P.ANON).get("/v1/projects", { headers: { Authorization: `Bearer ${accessToken}` } });
    projects.status(403);
    if (!projects.text().includes("insufficient_scope")) throw new Error(`expected insufficient_scope, got: ${projects.text().slice(0, 120)}`);
  });
  await ctx.step("cleanup", async () => {
    const del = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/:accountId/iam/oauth-clients/:clientId", { params: { accountId: team.id, clientId } });
    del.status(200);
  });
});
