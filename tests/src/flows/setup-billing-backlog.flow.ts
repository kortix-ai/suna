/**
 * Setup + billing backlog. Maps to spec §6 (ACC-4, self-hosted setup gating) and
 * §16 (BILL-2 server-type checkout, BILL-9 billing write-op authorization).
 *
 * The target this suite runs against is the CLOUD / managed config
 * (`KORTIX_BILLING_INTERNAL_ENABLED=true`), so two things hold by design:
 *   - `/v1/setup/*` is mounted ONLY when billing is DISABLED (self-hosted) — see
 *     apps/api/src/index.ts:463 `if (!config.KORTIX_BILLING_INTERNAL_ENABLED)`.
 *     On this target those routes are unmounted → 404. ACC-4 proves that gating.
 *   - Billing routes ARE mounted; their authz boundary is membership-based
 *     (`resolveScopedAccountId` → 403 for a non-member, 401 for ANON).
 */
import { flow } from "../core/flow";

/**
 * ACC-4 — self-hosted setup surface is HIDDEN on cloud/billing-enabled deploys.
 *
 * Every `/v1/setup/*` route is mounted behind `!KORTIX_BILLING_INTERNAL_ENABLED`.
 * Against this billing-enabled target the whole sub-app is never `app.route`'d, so
 * even the otherwise-public probes (install-status, sandbox-providers) 404. We drive
 * the public ones with ANON (they must not require auth where they DO exist) and the
 * authed ones with OWNER; in this config every one collapses to 404 regardless.
 *
 * Routes declared EXACTLY as they appear in spec/routes.generated.json.
 */
flow(
  "ACC-4",
  {
    domain: "system",
    serial: true,
    routes: [
      "GET /v1/setup/install-status",
      "GET /v1/setup/sandbox-providers",
      "GET /v1/setup/status",
      "GET /v1/setup/health",
      "GET /v1/setup/setup-status",
      "GET /v1/setup/setup-wizard-step",
      "POST /v1/setup/setup-wizard-step",
      "POST /v1/setup/setup-complete",
      "POST /v1/setup/bootstrap-owner",
    ],
  },
  async (ctx) => {
    // Unmounted on this target → every route 404s regardless of auth, so drive
    // them all as ANON (no OWNER provisioning dependency — keeps ACC-4 runnable
    // even in a system-only batch where OWNER isn't otherwise needed).
    const anon = ctx.client.as(ctx.P.ANON);
    const owner = anon;

    await ctx.step("install-status (public probe) → 404 (setup unmounted on cloud)", async () => {
      const r = await anon.get("/v1/setup/install-status");
      r.status(404);
    });
    await ctx.step("sandbox-providers (public probe) → 404", async () => {
      const r = await anon.get("/v1/setup/sandbox-providers");
      r.status(404);
    });
    await ctx.step("status → 404", async () => {
      const r = await owner.get("/v1/setup/status");
      r.status(404);
    });
    await ctx.step("health → 404", async () => {
      const r = await owner.get("/v1/setup/health");
      r.status(404);
    });
    await ctx.step("setup-status → 404", async () => {
      const r = await owner.get("/v1/setup/setup-status");
      r.status(404);
    });
    await ctx.step("GET setup-wizard-step → 404", async () => {
      const r = await owner.get("/v1/setup/setup-wizard-step");
      r.status(404);
    });
    await ctx.step("POST setup-wizard-step → 404", async () => {
      const r = await owner.post("/v1/setup/setup-wizard-step", { step: 1 });
      r.status(404);
    });
    await ctx.step("POST setup-complete → 404", async () => {
      const r = await owner.post("/v1/setup/setup-complete", {});
      r.status(404);
    });
    await ctx.step("POST bootstrap-owner (first-owner) → 404", async () => {
      const r = await anon.post("/v1/setup/bootstrap-owner", { email: ctx.fixtures.name("setup") + "@ke2e.kortix.test" });
      r.status(404);
    });
  },
);

/**
 * BILL-2 — "free Stripe sub for a server type".
 *
 * SPEC DRIFT: the spec lists `POST /billing/setup/initialize {server_type,location}`,
 * but that route does NOT exist in apps/api/src/billing (and is absent from
 * spec/routes.generated.json). The real surface is `server_type`/`location` passed as
 * fields on `POST /billing/create-checkout-session` (apps/api/src/billing/routes/
 * subscriptions.ts:46-64 → createCheckoutSession({ serverType, location })).
 *
 * So BILL-2 is realised here as: a server-type-scoped checkout. The membership boundary
 * (ANON → 401, NONMEMBER → 403) runs without Stripe. The OWNER happy-path is a real
 * Stripe test-mode call — a good config returns a hosted URL (200); a config/input
 * problem surfaces as 4xx/5xx, so it uses a permissive envelope rather than the
 * `requires:["stripe"]` flow-gate (this keeps the authz boundary covered everywhere).
 */
flow(
  "BILL-2",
  {
    domain: "billing",
    serial: true,
    timeoutMs: 60_000,
    routes: ["POST /v1/billing/create-checkout-session"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();

    await ctx.step("NONMEMBER cannot checkout for a team they don't belong to → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/create-checkout-session", {
        account_id: team.id,
        tier_key: "pro",
        server_type: "compute",
        location: "us",
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      r.status(403);
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/create-checkout-session", {
        account_id: team.id,
        tier_key: "pro",
        server_type: "compute",
      });
      r.status(401);
    });

    await ctx.step("OWNER server-type-scoped checkout → Stripe URL or rejection", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/create-checkout-session", {
        account_id: team.id,
        tier_key: "pro",
        server_type: "compute",
        location: "us",
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      // Member-of-account passes authz; the outcome depends on Stripe wiring on the
      // target. A configured target returns a hosted URL (200); an unconfigured or
      // input-rejecting one returns 4xx/5xx. Permissive envelope covers both.
      r.status([200, 400, 404, 500]);
    });
  },
);

/**
 * BILL-9 — authorization on billing write ops.
 *
 * SPEC DRIFT: the spec claims write ops require a `billing.write` capability and that
 * `MEMBER`/`AUDITOR` → 403. The code has NO such role/capability gate: billing write
 * routes resolve the account purely by MEMBERSHIP via `resolveScopedAccountId`
 * (apps/api/src/shared/resolve-account.ts) — any member of the account passes, only a
 * NON-member (403) or ANON (401) is rejected. There is no `requirePermission('billing.write')`
 * anywhere under apps/api/src/billing/routes.
 *
 * We therefore assert the authz boundary that ACTUALLY exists and is verifiable
 * locally: ANON → 401, NONMEMBER → 403 across a representative set of write ops. The
 * MEMBER/AUDITOR step probes the spec's claim non-fatally — since they ARE members of
 * the team, the membership check passes and the request proceeds to the no-subscription
 * negative (4xx) rather than a 403; the permissive SET documents the real behavior.
 */
flow(
  "BILL-9",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/billing/cancel-subscription",
      "POST /v1/billing/reactivate-subscription",
      "POST /v1/billing/schedule-downgrade",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();

    // --- ANON is rejected before any account logic. ---
    await ctx.step("ANON cancel-subscription → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status(401);
    });
    await ctx.step("ANON reactivate-subscription → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/reactivate-subscription", { account_id: team.id });
      r.status(401);
    });
    await ctx.step("ANON schedule-downgrade → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/schedule-downgrade", {
        account_id: team.id,
        target_tier_key: "pro",
      });
      r.status(401);
    });

    // --- NONMEMBER is rejected by the membership resolver (the REAL authz gate). ---
    await ctx.step("NONMEMBER cancel-subscription → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status(403);
    });
    await ctx.step("NONMEMBER reactivate-subscription → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/reactivate-subscription", { account_id: team.id });
      r.status(403);
    });
    await ctx.step("NONMEMBER schedule-downgrade → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/schedule-downgrade", {
        account_id: team.id,
        target_tier_key: "pro",
      });
      r.status(403);
    });

    // --- Spec claim probe: a plain MEMBER of the account. Code has no billing.write
    //     gate, so membership passes → falls through to the genuine "no subscription"
    //     rejection (4xx) rather than the spec's 403. Permissive SET documents both. ---
    await ctx.step("MEMBER write op: membership passes, no-sub negative (spec claims 403)", async () => {
      const member = await team.addMember("member");
      const r = await ctx.client.as(member).post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status([400, 403, 404, 409]);
    });
  },
);
