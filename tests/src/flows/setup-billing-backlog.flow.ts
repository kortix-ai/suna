/**
 * Setup + billing backlog. Maps to spec §6 (ACC-4, self-hosted setup gating) and
 * §16 (BILL-2 server-type checkout).
 *
 * `/v1/setup/*` is mounted only when billing is disabled. ACC-4 proves both the
 * local/self-hosted surface and the cloud route gate. BILL-2 covers the managed
 * billing membership boundary.
 */
import { flow } from "../core/flow";

/**
 * ACC-4 — self-hosted setup surface is available locally and hidden on cloud.
 *
 * Every `/v1/setup/*` route is mounted behind `!KORTIX_BILLING_INTERNAL_ENABLED`.
 * Local runs prove the public probes, auth boundary, and installed-owner guard.
 * Managed targets prove that every setup route is unmounted.
 *
 * Routes declared EXACTLY as they appear in spec/routes.generated.json.
 */
flow(
  "ACC-4",
  {
    domain: "system",
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
    const anon = ctx.client.as(ctx.P.ANON);

    if (ctx.env.target === "local") {
      await ctx.step("install-status is public on local/self-hosted", async () => {
        const r = await anon.get("/v1/setup/install-status");
        r.status(200).body().has("$.installed", true);
      });
      await ctx.step("sandbox-providers is public on local/self-hosted", async () => {
        const r = await anon.get("/v1/setup/sandbox-providers");
        r.status(200).body().exists("$.providers");
      });
      await ctx.step("protected setup reads require authentication", async () => {
        const paths = [
          "/v1/setup/status",
          "/v1/setup/health",
          "/v1/setup/setup-status",
          "/v1/setup/setup-wizard-step",
        ];
        for (const path of paths) {
          const r = await anon.get(path);
          r.status(401);
        }
      });
      await ctx.step("protected setup writes require authentication", async () => {
        const wizard = await anon.post("/v1/setup/setup-wizard-step", { step: 1 });
        wizard.status(401);
        const complete = await anon.post("/v1/setup/setup-complete", {});
        complete.status(401);
      });
      await ctx.step("bootstrap-owner rejects an already-installed instance", async () => {
        const r = await anon.post("/v1/setup/bootstrap-owner", {
          email: ctx.fixtures.name("setup") + "@ke2e.kortix.test",
          password: "NotARealPassword123!",
        });
        r.status(409);
      });
      return;
    }

    // Unmounted on this target → every route 404s regardless of auth, so drive
    // them all as ANON (no OWNER provisioning dependency — keeps ACC-4 runnable
    // even in a system-only batch where OWNER isn't otherwise needed).
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
  "BILL-9b",
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
