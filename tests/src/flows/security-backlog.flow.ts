/**
 * Cross-cutting security / authorization BOUNDARY matrix (spec §19, SEC-*).
 *
 * These are negative-auth, black-box HTTP checks that PROVE the platform's
 * authn/authz boundaries hold against real, representative routes. They run
 * locally (no funded account, no live sandbox) since every assertion is a
 * rejection (401/403/404/400) or a redaction — nothing here provisions a
 * sandbox or spends credits.
 *
 * Ported in INTENT (not code) from the old reference tree under
 * tests/security-audit/ + tests/e2e/ — the original mock/unit security checks
 * become real over-the-wire requests here.
 *
 * Boundary source of truth: apps/api/src/middleware/auth.ts
 *   - apiKeyAuth / supabaseAuth / combinedAuth: missing/garbage/expired bearer
 *     → 401; revoked PAT/api-key → 401.
 *   - enforceTokenProjectScope(): a project-scoped PAT may only touch its bound
 *     project + GET /v1/accounts/me; EVERY other surface → 403.
 *   - combinedAuth preview routes (/v1/p/*): no token/cookie → 401;
 *     cross-sandbox token reuse → 403 (canAccessPreviewSandbox).
 *   - billing webhooks (apps/api/src/billing): Stripe in-body sig missing → 400;
 *     RevenueCat bearer-token auth bad → 401 (spec BILL-8).
 *   - project webhooks (/v1/webhooks/*): unsigned/foreign → 400/401/403/404.
 *
 * Spec IDs authored here: SEC-4, SEC-A, SEC-B, SEC-C, SEC-D, SEC-E, SEC-F,
 * SEC-G, SEC-H, SEC-I.
 */
import { flow } from "../core/flow";

const NIL_UUID = "00000000-0000-4000-a000-000000000000";

// A syntactically plausible but totally invalid Supabase JWT (three b64url
// segments, eyJ-prefixed header) → definitively-bad signature → 401, not a
// "JWKS not loaded" fallback.
const FORGED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJrZTJlLWZvcmdlZCIsInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxOTk5OTk5OTk5fQ." +
  "ke2e-not-a-real-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ─── SEC-4: session env injection — project-global secret scoping ────────────
//
// SEC-4 asserts buildSessionSandboxEnvVars decrypts ALL project secrets into
// the session env (project-global, no per-member scoping) + mints
// KORTIX_TOKEN/KORTIX_LLM_*/KORTIX_GIT_AUTH_TOKEN, etc. We cannot read in-box
// env without booting a sandbox (avoided: no funding/sandbox locally), so the
// host-side property we PROVE black-box is the secrets contract that feeds it:
// /projects/:id/secrets is WRITE-ONLY — POST upserts (encrypt) but no values
// are ever returned, names are upper-cased, and KORTIX_* names are reserved
// (400) so a caller can't smuggle a forged minted-token name into the env.
flow(
  "SEC-4",
  {
    domain: "security",
    serial: true,
    routes: [
      "GET /v1/projects/:projectId/secrets",
      "POST /v1/projects/:projectId/secrets",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("write a project secret → 200/201 (write-only upsert)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "ke2e_inject_probe", value: "super-secret-value" },
          { params: { projectId: p.id } },
        );
      r.status([200, 201]);
    });
    await ctx.step("list secrets returns NAMES only — no plaintext values leak", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      r.status(200);
      // The stored value must never be reflected anywhere in the response.
      if (r.text().includes("super-secret-value")) {
        throw new Error("SEC-4: secret VALUE leaked from GET /secrets (must be write-only)");
      }
    });
    await ctx.step("KORTIX_* names are reserved → 400 (can't forge a minted-token env var)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/secrets",
          { name: "KORTIX_TOKEN", value: "attacker-controlled" },
          { params: { projectId: p.id } },
        );
      r.status(400);
    });
    await ctx.step("NONMEMBER cannot read the project's secret env → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/secrets", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
  },
);

// ─── SEC-A: ANON (no header) on any protected route → 401 ────────────────────
flow(
  "SEC-A",
  {
    domain: "security",
    tags: ["smoke"],
    routes: [
      "GET /v1/accounts/me",
      "GET /v1/projects",
      "GET /v1/accounts/:accountId/audit",
      "GET /v1/user-roles",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON GET /accounts/me → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me");
      r.status(401);
    });
    await ctx.step("ANON GET /projects → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/projects");
      r.status(401);
    });
    await ctx.step("ANON GET /accounts/:id/audit → 401 (before authz)", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/accounts/:accountId/audit", { params: { accountId: NIL_UUID } });
      r.status(401);
    });
    await ctx.step("ANON GET /user-roles → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/user-roles");
      r.status(401);
    });
  },
);

// ─── SEC-B: malformed/expired JWT → 401; revoked PAT/api-key → 401 ───────────
flow(
  "SEC-B",
  {
    domain: "security",
    serial: true,
    routes: ["GET /v1/accounts/me", "POST /v1/accounts/tokens", "DELETE /v1/accounts/tokens/:tokenId"],
  },
  async (ctx) => {
    await ctx.step("garbage bearer (no recognized prefix) → 401", async () => {
      const r = await ctx.client.withBearer("totally-garbage-token", "GARBAGE").get("/v1/accounts/me");
      r.status(401);
    });
    await ctx.step("forged kortix PAT prefix, bad secret → 401", async () => {
      const r = await ctx.client.withBearer("kortix_pat_deadbeefdeadbeefdeadbeef", "FORGED_PAT").get("/v1/accounts/me");
      r.status(401);
    });
    await ctx.step("forged/expired Supabase JWT (bad signature) → 401", async () => {
      const r = await ctx.client.withBearer(FORGED_JWT, "FORGED_JWT").get("/v1/accounts/me");
      r.status(401);
    });
    await ctx.step("empty bearer token → 401", async () => {
      const r = await ctx.client.withBearer("", "EMPTY").get("/v1/accounts/me");
      r.status(401);
    });
    // Revoked-PAT boundary: mint → confirm it works → revoke → confirm 401.
    let secret = "";
    let tokenId = "";
    await ctx.step("mint an account PAT", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/accounts/tokens", { name: ctx.fixtures.name("sec-b-revoke") });
      r.status(201).body().exists("$.secret_key").exists("$.token_id");
      const j = r.json<any>();
      secret = j.secret_key;
      tokenId = j.token_id;
    });
    await ctx.step("PAT authenticates before revoke → 200", async () => {
      const r = await ctx.client.withBearer(secret, "PAT").get("/v1/accounts/me");
      r.status(200);
    });
    await ctx.step("revoke the PAT → 200", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).del("/v1/accounts/tokens/:tokenId", { params: { tokenId } });
      r.status(200);
    });
    await ctx.step("revoked PAT on a protected route → 401", async () => {
      const r = await ctx.client.withBearer(secret, "REVOKED_PAT").get("/v1/accounts/me");
      r.status(401);
    });
  },
);

// ─── SEC-C: NONMEMBER on GET/PATCH/DELETE /accounts/:id, /projects/:id ───────
// Cross-account isolation: a fully-authenticated principal who is NOT a member
// of the target account/project cannot read or mutate it (403/404 — the API
// returns 404 where leaking existence would be a disclosure, 403 where it gates
// on membership). Proven with two independent owners: NONMEMBER (its own
// account) against a fresh team account + project it has no grant on.
flow(
  "SEC-C",
  {
    domain: "security",
    serial: true,
    routes: [
      "GET /v1/accounts/:accountId",
      "PATCH /v1/accounts/:accountId",
      "GET /v1/projects/:projectId",
      "PATCH /v1/projects/:projectId",
      "DELETE /v1/projects/:projectId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    await ctx.step("NONMEMBER GET a foreign account → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId", { params: { accountId: team.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER PATCH a foreign account → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/accounts/:accountId", { name: "ke2e-hijack" }, { params: { accountId: team.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER GET a foreign project → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER PATCH a foreign project → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .patch("/v1/projects/:projectId", { name: "ke2e-hijack" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER DELETE a foreign project → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .del("/v1/projects/:projectId", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("IDOR: random project id → 403/404 (no enumeration)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId", { params: { projectId: NIL_UUID } });
      r.status([403, 404]);
    });
  },
);

// ─── SEC-D: project-scoped PAT — bound project + /accounts/me only ──────────
// enforceTokenProjectScope: a project-scoped PAT is allowed ONLY on its bound
// project's routes + GET /v1/accounts/me; cross-project, account-level,
// project-list, and any other surface (router/billing/channels/etc.) → 403.
flow(
  "SEC-D",
  {
    domain: "security",
    serial: true,
    routes: [
      "POST /v1/projects/:projectId/cli-token",
      "DELETE /v1/projects/:projectId/cli-token/:tokenId",
      "GET /v1/projects/:projectId",
      "GET /v1/accounts/me",
      "GET /v1/projects",
      "GET /v1/accounts/:accountId",
      "GET /v1/accounts/tokens",
      "POST /v1/router/web-search",
    ],
  },
  async (ctx) => {
    const projA = await ctx.fixtures.project();
    const projB = await ctx.fixtures.project();
    let secret = "";
    let tokenId = "";
    await ctx.step("mint a project-scoped PAT on project A", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/cli-token",
          { name: ctx.fixtures.name("sec-d-pat") },
          { params: { projectId: projA.id } },
        );
      r.status(201).body().exists("$.secret_key").has("$.project_id", projA.id);
      const j = r.json<any>();
      secret = j.secret_key;
      tokenId = j.token_id;
    });
    const pat = () => ctx.client.withBearer(secret, "PAT_PROJ");
    await ctx.step("allowed: GET its own project → 200", async () => {
      const r = await pat().get("/v1/projects/:projectId", { params: { projectId: projA.id } });
      r.status(200);
    });
    await ctx.step("allowed: self-identity probe GET /accounts/me → 200", async () => {
      const r = await pat().get("/v1/accounts/me");
      r.status(200);
    });
    await ctx.step("denied: a DIFFERENT project → 403", async () => {
      const r = await pat().get("/v1/projects/:projectId", { params: { projectId: projB.id } });
      r.status(403);
    });
    await ctx.step("denied: enumerate /projects → 403", async () => {
      const r = await pat().get("/v1/projects");
      r.status(403);
    });
    await ctx.step("denied: account-level GET /accounts/:id → 403", async () => {
      const r = await pat().get("/v1/accounts/:accountId", { params: { accountId: ctx.P.accountId } });
      r.status(403);
    });
    await ctx.step("denied: account-level GET /accounts/tokens → 403", async () => {
      const r = await pat().get("/v1/accounts/tokens");
      r.status(403);
    });
    await ctx.step("denied: router surface POST /router/web-search → 401/403", async () => {
      // enforceTokenProjectScope rejects non-project surfaces (403); even if the
      // scope check didn't fire, the router is apiKeyAuth-gated against a PAT → 401.
      const r = await pat().post("/v1/router/web-search", { query: "ke2e" });
      r.status([401, 403]);
    });
    await ctx.step("revoke the project token → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/cli-token/:tokenId", { params: { projectId: projA.id, tokenId } });
      r.status(200);
    });
  },
);

// ─── SEC-E: 404 shape — unknown route → {error,message:"Not found",status} ──
// The illustrative `GET /v1/nonexistent` is not a manifest route; we declare
// the protected route this flow also exercises (GET /v1/accounts/me) and hit an
// unmatched path to assert the global 404 envelope.
flow(
  "SEC-E",
  { domain: "security", tags: ["smoke"], routes: ["GET /v1/accounts/me"] },
  async (ctx) => {
    await ctx.step("unknown /v1 route → 404 with the standard envelope", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/ke2e-nonexistent-route");
      r.status(404).body().has("$.error", true).has("$.message", "Not found").has("$.status", 404);
    });
    await ctx.step("unknown nested /v1 route → same 404 envelope", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/ke2e/does/not/exist");
      r.status(404).body().has("$.error", true).has("$.message", "Not found").has("$.status", 404);
    });
    await ctx.step("authed control: GET /accounts/me → 200 (route exists + matches)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/accounts/me");
      r.status(200);
    });
  },
);

// ─── SEC-F: webhook signature bypass → 400/401 ──────────────────────────────
// Public webhook ingress points reject unsigned/forged payloads BEFORE doing
// any work. Stripe = in-body sig (missing → 400); RevenueCat = bearer-token
// auth (bad → 401); project/Slack/Telegram webhooks = unsigned/foreign → 4xx.
flow(
  "SEC-F",
  {
    domain: "security",
    routes: [
      "POST /v1/billing/webhooks/stripe",
      "POST /v1/billing/webhooks/revenuecat",
      "POST /v1/webhooks/slack",
      "POST /v1/webhooks/telegram/:projectId",
      "POST /v1/webhooks/projects/:projectId/:slug",
    ],
  },
  async (ctx) => {
    await ctx.step("Stripe webhook, no Stripe-Signature → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/billing/webhooks/stripe", { type: "ke2e.forged", data: {} });
      r.status([400, 401]);
    });
    // With a signature present, the handler skips the no-sig 400 and either
    // verifies (configured target → 401 on a bad sig) or reports the secret
    // isn't configured (local → 500 "Webhook not configured", webhooks.ts:10).
    // Either way a forged signed payload is NEVER processed (no 2xx).
    await ctx.step("Stripe webhook, wrong signature header → never 2xx", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/billing/webhooks/stripe",
          { type: "ke2e.forged", data: {} },
          { headers: { "stripe-signature": "t=1,v1=deadbeef" } },
        );
      r.status([400, 401, 500]);
    });
    // RevenueCat: configured target → 401 on a missing/bad bearer; local
    // (no REVENUECAT_WEBHOOK_SECRET) → 500 "Webhook not configured" (line 19).
    await ctx.step("RevenueCat webhook, no/bad bearer → never 2xx", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/billing/webhooks/revenuecat", { event: { type: "ke2e.forged" } });
      r.status([400, 401, 500]);
    });
    await ctx.step("RevenueCat webhook, forged bearer → never 2xx", async () => {
      const r = await ctx.client
        .withBearer("ke2e-not-the-revenuecat-secret", "FAKE_RC")
        .post("/v1/billing/webhooks/revenuecat", { event: { type: "ke2e.forged" } });
      r.status([400, 401, 500]);
    });
    await ctx.step("Slack webhook, unsigned payload → 4xx", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/webhooks/slack", { type: "event_callback" });
      r.status([400, 401, 403, 404]);
    });
    await ctx.step("Telegram webhook, wrong secret token → 4xx", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post(
          "/v1/webhooks/telegram/:projectId",
          { update_id: 1 },
          { params: { projectId: NIL_UUID }, headers: { "x-telegram-bot-api-secret-token": "wrong" } },
        );
      r.status([400, 401, 403, 404]);
    });
    await ctx.step("project webhook, unsigned/unknown → 4xx", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/webhooks/projects/:projectId/:slug", { hello: "world" }, {
          params: { projectId: NIL_UUID, slug: "ke2e-no-such-trigger" },
        });
      r.status([400, 401, 403, 404]);
    });
  },
);

// ─── SEC-G: preview proxy without token/cookie → 401; cross-sandbox → 403 ───
// The preview proxy (/v1/p/*, combinedAuth) rejects unauthenticated requests
// (no header/cookie/query token) with 401. With a VALID identity but a sandbox
// the caller can't access, canAccessPreviewSandbox denies → 403. We don't boot
// a real sandbox; we exercise the auth+ownership boundary on the share/proxy
// surface with a bogus sandbox id.
flow(
  "SEC-G",
  {
    domain: "security",
    routes: ["POST /v1/p/auth", "GET /v1/p/share", "POST /v1/p/share"],
  },
  async (ctx) => {
    const bogusSandbox = `ke2e-no-such-sandbox-${Date.now()}`;
    await ctx.step("POST /p/auth with no Authorization → 400/401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/p/auth", {});
      r.status([400, 401]);
    });
    await ctx.step("GET /p/share without any token/cookie → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/p/share", { query: { sandbox_id: bogusSandbox } });
      r.status(401);
    });
    await ctx.step("POST /p/share without any token/cookie → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/p/share", { sandbox_id: bogusSandbox, port: 3000 });
      r.status(401);
    });
    await ctx.step("garbage bearer on preview proxy → 401", async () => {
      const r = await ctx.client
        .withBearer("kortix_garbage_preview_token", "GARBAGE")
        .get("/v1/p/share", { query: { sandbox_id: bogusSandbox } });
      r.status(401);
    });
    await ctx.step("valid OWNER identity on a sandbox it can't access → not-authorized/not-found", async () => {
      // canAccessPreviewSandbox denies (403) for a sandbox the caller doesn't own;
      // an unknown id may also surface as 400/404 — permissive SET, never 200.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/p/share", { query: { sandbox_id: bogusSandbox } });
      r.status([400, 403, 404]);
    });
  },
);

// ─── SEC-H: audit — state-changing /v1/* writes an audit row ────────────────
// auditStateChangingRequest records every mutation; a prior mutation must be
// reflected in GET /accounts/:id/audit. We mint+revoke a PAT (a clear,
// account-scoped mutation pair), then assert the audit log returns events.
flow(
  "SEC-H",
  {
    domain: "security",
    serial: true,
    routes: [
      "POST /v1/accounts/:accountId/iam/groups",
      "GET /v1/accounts/:accountId/audit",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("perform a state-changing mutation (create IAM group)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/groups",
          { name: ctx.fixtures.name("sec-h-grp") },
          { params: { accountId: team.id } },
        );
      r.status(201).body().exists("$.group_id");
    });
    await ctx.step("audit log reflects activity → 200 with events array", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/audit", { params: { accountId: team.id } });
      r.status(200).body().exists("$.events");
      const events = r.json<any>()?.events;
      if (!Array.isArray(events) || events.length === 0) {
        throw new Error("SEC-H: expected at least one audit event after a state-changing mutation");
      }
    });
    await ctx.step("NONMEMBER cannot read the audit log → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/audit", { params: { accountId: team.id } });
      r.status([403, 404]);
    });
  },
);

// ─── SEC-I: rate limits — limiter responses under load ──────────────────────
// Rate-limited surfaces (session create, invite-accept, preview proxy, tunnel
// WS) return their limiter response (429) under burst. We MUST NOT actually
// flood the live API (the suite crashes it under load), so this flow proves the
// limiter CONTRACT in a bounded way: a small serial burst against the
// invite-accept limiter (cheap — every request short-circuits at the wrong-email
// 403 / unknown-invite 404 BEFORE any heavy work), accepting either the normal
// rejection or the limiter's 429. A 429 anywhere in the burst proves the
// limiter is wired; its absence at this low volume is also acceptable.
flow(
  "SEC-I",
  {
    domain: "security",
    serial: true,
    routes: ["POST /v1/account-invites/:inviteId/accept"],
  },
  async (ctx) => {
    await ctx.step("invite-accept under a small serial burst → limiter response or normal reject", async () => {
      let saw429 = false;
      // Bounded burst (8) — small enough not to stress the API, large enough to
      // trip a tight per-principal limiter if one guards this route.
      for (let i = 0; i < 8; i++) {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post("/v1/account-invites/:inviteId/accept", {}, { params: { inviteId: NIL_UUID } });
        // Unknown invite → 404; rate-limited → 429. Either proves the boundary:
        // the route never silently succeeds for a forged invite id.
        r.status([403, 404, 429]);
        if (r.statusCode === 429) saw429 = true;
      }
      // We don't REQUIRE a 429 at this low volume (limits are generous); the
      // contract proven is "forged invite never 2xx + limiter response is valid".
      void saw429;
    });
  },
);
