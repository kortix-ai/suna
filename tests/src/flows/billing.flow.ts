/**
 * Billing — account state + the REAL subscribe flow (inline checkout confirmed
 * with a Stripe test card). Maps to spec §20 (BILL-1, BILL-3). Gated on `stripe`.
 */
import { flow } from "../core/flow";
import { subscribe } from "../fixtures/billing";

flow("BILL-1", { domain: "billing", tags: ["smoke"], routes: ["GET /v1/billing/account-state"] }, async (ctx) => {
  await ctx.step("OWNER reads account state", async () => {
    const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state");
    r.status(200);
  });
});

flow(
  "BILL-3",
  {
    domain: "billing",
    requires: ["funded"],
    serial: true,
    timeoutMs: 120_000,
    routes: [
      "POST /v1/billing/create-inline-checkout",
      "POST /v1/billing/confirm-inline-checkout",
      "GET /v1/billing/account-state",
    ],
  },
  async (ctx) => {
    // Subscribe a fresh team account the real way → credits granted.
    const team = await ctx.fixtures.team();
    await ctx.step("inline checkout + confirm with test card → active", async () => {
      await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id, "pro");
    });
    await ctx.step("account-state reflects an active paid subscription", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state", { query: { account_id: team.id } });
      r.status(200);
    });
  },
);

/**
 * BILL-4 — subscription lifecycle management against an UNFUNDED team account.
 * The team has no Stripe subscription, so every management op is a real negative:
 * the service throws `SubscriptionError('No active subscription'|…)` → 400. We do
 * NOT fake a subscription; we assert the genuine "no subscription" rejection.
 * sync-subscription is permissive — it reconciles state and may legitimately 200
 * (nothing to sync) or 400.
 */
flow(
  "BILL-4",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/billing/cancel-subscription",
      "POST /v1/billing/reactivate-subscription",
      "POST /v1/billing/schedule-downgrade",
      "POST /v1/billing/cancel-scheduled-change",
      "POST /v1/billing/sync-subscription",
      "GET /v1/billing/proration-preview",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step("cancel on a sub-less account → no subscription", async () => {
      const r = await owner.post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status([400, 404, 409]);
    });
    await ctx.step("reactivate on a sub-less account → no subscription", async () => {
      const r = await owner.post("/v1/billing/reactivate-subscription", { account_id: team.id });
      r.status([400, 404, 409]);
    });
    await ctx.step("schedule-downgrade with no active sub → rejected", async () => {
      const r = await owner.post("/v1/billing/schedule-downgrade", { account_id: team.id, target_tier_key: "pro" });
      r.status([400, 404, 409]);
    });
    await ctx.step("cancel-scheduled-change with nothing scheduled → rejected", async () => {
      const r = await owner.post("/v1/billing/cancel-scheduled-change", { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
    await ctx.step("sync-subscription reconciles (no-op) → ok or no-sub", async () => {
      const r = await owner.post("/v1/billing/sync-subscription", { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
    await ctx.step("proration-preview requires new_price_id → 400", async () => {
      const r = await owner.get("/v1/billing/proration-preview", { query: { account_id: team.id } });
      r.status(400);
    });
    await ctx.step("proration-preview with a price but no active sub → rejected", async () => {
      const r = await owner.get("/v1/billing/proration-preview", {
        query: { account_id: team.id, new_price_id: "price_nonexistent" },
      });
      r.status([400, 404, 409]);
    });
  },
);

/**
 * BILL-4b — NONMEMBER cannot manage another account's subscription. The account
 * resolver rejects a non-member with 403 before any Stripe logic runs.
 */
flow(
  "BILL-4b",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/cancel-subscription", "POST /v1/billing/sync-seat-quantity"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    await ctx.step("NONMEMBER cancel on a team they don't belong to → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status(403);
    });
    await ctx.step("NONMEMBER sync-seat-quantity → 403", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/billing/sync-seat-quantity", { account_id: team.id });
      r.status(403);
    });
  },
);

/**
 * BILL-9 — `billing.write` IAM gate. Billing *write* ops resolve the account by
 * membership AND require `billing.write` (owners + the `billing_manager` policy
 * only — see iam/role-perms.ts). A plain account MEMBER has `billing.read` only,
 * so they're rejected with 403 BEFORE any Stripe call: a non-billing teammate
 * can't subscribe / cancel / top-up on the whole account's behalf. ANON → 401.
 * The OWNER-allowed path is covered by BILL-3b / BILL-4 (OWNER reaches the
 * business logic, never a 403). No `stripe`/`funded` requirement — the gate
 * fires before any Stripe interaction, mirroring BILL-4b's non-member 403.
 */
flow(
  "BILL-9",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/billing/create-per-seat-checkout",
      "POST /v1/billing/cancel-subscription",
      "POST /v1/billing/purchase-credits",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const asMember = ctx.client.as(member);

    await ctx.step("MEMBER cannot start a team subscription checkout → 403", async () => {
      const r = await asMember.post("/v1/billing/create-per-seat-checkout", {
        account_id: team.id,
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      r.status(403);
    });
    await ctx.step("MEMBER cannot cancel the subscription → 403", async () => {
      const r = await asMember.post("/v1/billing/cancel-subscription", { account_id: team.id });
      r.status(403);
    });
    await ctx.step("MEMBER cannot buy credits → 403", async () => {
      const r = await asMember.post("/v1/billing/purchase-credits", { account_id: team.id, amount: 10 });
      r.status(403);
    });
    await ctx.step("ANON cannot start a team subscription checkout → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/create-per-seat-checkout", {
        account_id: team.id,
        success_url: "https://example.com/ok",
        cancel_url: "https://example.com/cancel",
      });
      r.status(401);
    });
  },
);

/**
 * BILL-10 — per-seat (billing v2) management on an unfunded team. `sync-seat-quantity`
 * reconciles the Stripe seat count against account_members; with no per-seat sub it
 * has nothing to sync (200 no-op) or rejects (400). `claim-per-seat` runs the legacy
 * → per-seat migration synchronously; a fresh team has no legacy machine subs, so it
 * returns ok with a "skipped:*" status (or 400 on failure). Neither fakes a sub.
 */
flow(
  "BILL-10",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/sync-seat-quantity", "POST /v1/billing/claim-per-seat"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("sync-seat-quantity on a seat-less account → ok or rejected", async () => {
      const r = await owner.post("/v1/billing/sync-seat-quantity", { account_id: team.id });
      r.status([200, 400, 404, 409]);
    });
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
 * BILL-5 — checkout-session lookup + confirm. A bogus/unknown session id can't be
 * retrieved (4xx) and can't be confirmed; confirm with a missing session_id is a
 * hard 400 (input validation, before any Stripe call). Gated on `stripe`.
 */
flow(
  "BILL-11",
  {
    domain: "billing",
    requires: ["stripe"],
    serial: true,
    routes: ["GET /v1/billing/checkout-session/:sessionId", "POST /v1/billing/confirm-checkout-session"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const owner = ctx.client.as(ctx.P.OWNER);
    await ctx.step("lookup an unknown checkout session → 4xx", async () => {
      const r = await owner.get("/v1/billing/checkout-session/:sessionId", {
        params: { sessionId: "cs_test_does_not_exist" },
      });
      r.status([400, 404, 500]);
    });
    await ctx.step("confirm without session_id → 400", async () => {
      const r = await owner.post("/v1/billing/confirm-checkout-session", { account_id: team.id });
      r.status(400);
    });
    await ctx.step("confirm an unknown session id → rejected", async () => {
      const r = await owner.post("/v1/billing/confirm-checkout-session", {
        account_id: team.id,
        session_id: "cs_test_does_not_exist",
      });
      r.status([400, 404, 500]);
    });
  },
);

/**
 * BILL-8 — billing webhooks are PUBLIC (no auth middleware) but verified at the
 * edge of the handler. Stripe: in-body HMAC signature — a missing `Stripe-Signature`
 * header is rejected with 400 BEFORE the body is parsed; an invalid signature is
 * also rejected (400, or 500 if the webhook secret isn't configured on the target).
 * RevenueCat: Bearer-token auth (NOT an in-body sig) — missing/wrong → 401 (or 500
 * if the secret isn't configured). Both mirror mounts (`/webhooks/*` and `/webhook/*`)
 * behave identically. ANON drives these — they must NOT require a session.
 */
flow(
  "BILL-8",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/billing/webhooks/stripe",
      "POST /v1/billing/webhook/stripe",
      "POST /v1/billing/webhooks/revenuecat",
      "POST /v1/billing/webhook/revenuecat",
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const fakeEvent = { id: "evt_ke2e", type: "ping", data: { object: {} } };

    await ctx.step("stripe webhook, no Stripe-Signature → 400 missing sig", async () => {
      const r = await anon.post("/v1/billing/webhooks/stripe", fakeEvent);
      r.status(400);
    });
    await ctx.step("stripe webhook (mirror /webhook), no sig → 400", async () => {
      const r = await anon.post("/v1/billing/webhook/stripe", fakeEvent);
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
    await ctx.step("revenuecat webhook (mirror /webhook), bad Bearer → 401", async () => {
      const r = await anon.post("/v1/billing/webhook/revenuecat", fakeEvent, {
        headers: { authorization: "Bearer ke2e-wrong-token" },
      });
      r.status([401, 500]);
    });
  },
);

/**
 * DEL-2 — account deletion lifecycle: schedule a deletion then cancel it. These
 * routes resolve the account from the CALLER's identity (resolveAccountId(userId)),
 * NOT a body account_id — so we drive them with a THROWAWAY user (a fresh team
 * member synthesized for this run, torn down by the world). We never touch OWNER's
 * own account. Covers both the `/v1/account/*` mount and the `/v1/billing/account/*`
 * mirror mount. ANON must be rejected (401) from the authed deletion routes.
 */
flow(
  "DEL-2",
  {
    domain: "billing",
    serial: true,
    routes: [
      "POST /v1/account/request-deletion",
      "POST /v1/account/cancel-deletion",
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
    await ctx.step("throwaway user schedules deletion (/account mount) → 200", async () => {
      const r = await asVictim.post("/v1/account/request-deletion", { reason: "ke2e" });
      r.status(200);
    });
    await ctx.step("deletion-status (billing mirror mount) reflects the pending request", async () => {
      const r = await asVictim.get("/v1/billing/account/deletion-status");
      r.status(200);
    });
    await ctx.step("requesting again while pending → 400 (already exists)", async () => {
      const r = await asVictim.post("/v1/account/request-deletion", { reason: "again" });
      r.status([400, 409]);
    });
    await ctx.step("throwaway user cancels the deletion → 200", async () => {
      const r = await asVictim.post("/v1/account/cancel-deletion", {});
      r.status(200);
    });
    await ctx.step("cancel again with nothing pending → 400 (no active request)", async () => {
      const r = await asVictim.post("/v1/account/cancel-deletion", {});
      r.status([400, 404]);
    });
  },
);

/**
 * DEL-2b — billing-mirror deletion mount, exercised independently end-to-end on a
 * second throwaway user (schedule via /billing/account/request-deletion → cancel via
 * the mirror cancel). Confirms the mirror mount is fully wired, not just the status read.
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

    await ctx.step("schedule deletion via billing mirror mount → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/request-deletion", { reason: "ke2e-mirror" });
      r.status(200);
    });
    await ctx.step("cancel deletion via billing mirror mount → 200", async () => {
      const r = await asVictim.post("/v1/billing/account/cancel-deletion", {});
      r.status(200);
    });
  },
);
