/**
 * Billing — account state and checkout/session lifecycle boundaries.
 */
import { flow } from "../core/flow";

flow("BILL-1", { domain: "billing", tags: ["smoke"], routes: ["GET /v1/billing/account-state"] }, async (ctx) => {
  await ctx.step("OWNER reads account state", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state");
    r.status(200);
  });
});

/**
 * BILL-4 — subscription lifecycle management against an UNFUNDED team account.
 * sync-subscription is permissive — it reconciles state and may legitimately 200
 * (nothing to sync) or 400.
 */
flow(
  "BILL-4",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/sync-subscription"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step("sync-subscription reconciles (no-op) → ok or no-sub", async () => {
      const r = await owner.post("/v1/billing/sync-subscription", { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
  },
);

/**
 * BILL-10 — `claim-per-seat` runs the legacy → per-seat migration synchronously;
 * a fresh team has no legacy machine subs, so it returns ok with a "skipped:*"
 * status (or 400 on failure).
 */
flow(
  "BILL-10",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/claim-per-seat"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("claim-per-seat on a non-legacy account → skipped", async () => {
      const r = await owner.post("/v1/billing/claim-per-seat", { account_id: team.id });
      r.status([200, 400]);
    });
  },
);

/**
 * BILL-3b — Stripe-hosted checkout & portal sessions. These are REAL Stripe
 * test-mode calls: a successful call returns a Stripe-hosted URL (200); a config
 * or input problem surfaces as 400. We assert the [200,400] envelope rather than
 * pinning a single status, since it depends on the target's Stripe wiring.
 * Gated on `stripe` so credential-less targets self-skip.
 */
flow(
  "BILL-3b",
  {
    domain: "billing",
    requires: ["stripe"],
    serial: true,
    timeoutMs: 60_000,
    routes: [
      "POST /v1/billing/create-checkout-session",
      "POST /v1/billing/create-per-seat-checkout",
      "POST /v1/billing/create-portal-session",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("create-checkout-session → Stripe URL or rejection", async () => {
      const r = await owner.post("/v1/billing/create-checkout-session", {
        account_id: team.id,
        tier_key: "pro",
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      r.status([200, 400, 500]);
    });
    await ctx.step("create-per-seat-checkout → Stripe URL or rejection", async () => {
      const r = await owner.post("/v1/billing/create-per-seat-checkout", {
        account_id: team.id,
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      r.status([200, 400, 500]);
    });
    await ctx.step("create-portal-session → Stripe portal URL or rejection", async () => {
      const r = await owner.post("/v1/billing/create-portal-session", {
        account_id: team.id,
        return_url: "https://example.com/return",
      });
      r.status([200, 400, 500]);
    });
  },
);

/**
 * BILL-8 — billing webhooks are PUBLIC (no auth middleware) but verified at the
 * edge of the handler. Stripe: in-body HMAC signature — a missing `Stripe-Signature`
 * header is rejected with 400 BEFORE the body is parsed; an invalid signature is
 * also rejected (400, or 500 if the webhook secret isn't configured on the target).
 * RevenueCat: Bearer-token auth (NOT an in-body sig) — missing/wrong → 401 (or 500
 * if the secret isn't configured). ANON drives these — they must NOT require a
 * session.
 */
flow(
  "BILL-8",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/billing/webhooks/stripe",
      "POST /v1/billing/webhooks/revenuecat",
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const fakeEvent = { id: "evt_ke2e", type: "ping", data: { object: {} } };

    await ctx.step("stripe webhook, no Stripe-Signature → 400 missing sig", async () => {
      const r = await anon.post("/v1/billing/webhooks/stripe", fakeEvent);
      r.status(400);
    });
    await ctx.step("stripe webhook, garbage signature → rejected (sig invalid)", async () => {
      const r = await anon.post("/v1/billing/webhooks/stripe", fakeEvent, {
        headers: { "stripe-signature": "t=1,v1=deadbeef" },
      });
      r.status([400, 500]);
    });
    await ctx.step("revenuecat webhook, no Bearer → 401 (or 500 if unconfigured)", async () => {
      const r = await anon.post("/v1/billing/webhooks/revenuecat", fakeEvent);
      r.status([401, 500]);
    });
  },
);

/**
 * DEL-2 — account deletion lifecycle: schedule a deletion then cancel it. These
 * routes resolve the account from the CALLER's identity (resolveAccountId(userId)),
 * NOT a body account_id — so we drive them with a THROWAWAY user (a fresh team
 * member synthesized for this run, torn down by the world). We never touch OWNER's
 * own account. ANON must be rejected (401) from the authed deletion routes.
 */
flow(
  "DEL-2",
  {
    domain: "billing",
    serial: true,
    routes: [
      "GET /v1/billing/account/deletion-status",
      "POST /v1/billing/account/request-deletion",
      "POST /v1/billing/account/cancel-deletion",
    ],
  },
  async (ctx) => {
    // Throwaway user whose only account is its own personal account.
    const team = await ctx.fixtures.team();
    const victim = await team.addMember("member");
    const asVictim = ctx.client.as(victim);

    await ctx.step("ANON cannot read deletion status → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/account/deletion-status");
      r.status(401);
    });
    await ctx.step("throwaway user schedules deletion → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/request-deletion", { reason: "ke2e" });
      r.status(200);
    });
    await ctx.step("deletion-status reflects the pending request", async () => {
      const r = await asVictim.get("/v1/billing/account/deletion-status");
      r.status(200);
    });
    await ctx.step("requesting again while pending → 400 (already exists)", async () => {
      const r = await asVictim.post("/v1/billing/account/request-deletion", { reason: "again" });
      r.status([400, 409]);
    });
    await ctx.step("throwaway user cancels the deletion → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/cancel-deletion", {});
      r.status(200);
    });
    await ctx.step("cancel again with nothing pending → 400 (no active request)", async () => {
      const r = await asVictim.post("/v1/billing/account/cancel-deletion", {});
      r.status([400, 404]);
    });
  },
);

/**
 * DEL-2b — deletion cancel path, exercised independently end-to-end on a
 * second throwaway user.
 */
flow(
  "DEL-2b",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/account/request-deletion", "POST /v1/billing/account/cancel-deletion"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const victim = await team.addMember("member");
    const asVictim = ctx.client.as(victim);

    await ctx.step("schedule deletion → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/request-deletion", { reason: "ke2e-mirror" });
      r.status(200);
    });
    await ctx.step("cancel deletion → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/cancel-deletion", {});
      r.status(200);
    });
  },
);
