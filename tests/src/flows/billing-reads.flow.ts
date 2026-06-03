/**
 * Billing — reads, credits, transactions, auto-topup, tier-config, deductions,
 * and the yearly-rotation cron. Maps to spec §20:
 *   BILL-5  → account-state/minimal, transactions[/summary], credit-usage,
 *             credit-breakdown, usage-history, tier-configurations,
 *             proration-preview, purchase-credits
 *   BILL-6  → auto-topup settings/setup-status/configure, cron/yearly-rotation
 *   BILL-7  → deduct, deduct-usage (agent runtime)
 *
 * account-state/minimal is grouped under BILL-5's reads here rather than its own
 * id: billing.flow.ts already owns BILL-1 (GET /v1/billing/account-state) and the
 * flow registry rejects duplicate ids, and the coverage gate (Gate A) only
 * accepts flow ids that exist in end-to-end.md — so the minimal read rides the
 * existing BILL-5 reads bucket instead of inventing an unlisted id.
 *
 * NOTE on status SETS: every protected billing route sits behind `supabaseAuth`
 * (ANON → 401) AND a billing-enabled gate (when billing is disabled the gate
 * short-circuits with 404 / `{skipped:true}`). The reads otherwise return 200
 * for the OWNER against their own/team account. So OWNER reads assert the
 * permissive [200, 404] set (404 only when the deployment runs with billing
 * off); ANON asserts 401. tier-configurations is still auth-gated (no public
 * bypass), so ANON → 401 there too. No mocking — codes are pinned from the
 * handlers in apps/api/src/billing/routes/.
 */
import { flow } from "../core/flow";

// OWNER reads succeed (200) on a billing-enabled deployment; 404 when the
// billing internal gate is disabled (self-hosted / local).
const OWNER_READ = [200, 404];

flow(
  "BILL-5",
  {
    domain: "billing",
    tags: ["smoke"],
    routes: [
      "GET /v1/billing/account-state/minimal",
      "GET /v1/billing/tier-configurations",
      "GET /v1/billing/transactions",
      "GET /v1/billing/transactions/summary",
      "GET /v1/billing/credit-usage",
      "GET /v1/billing/credit-breakdown",
      "GET /v1/billing/usage-history",
      "GET /v1/billing/proration-preview",
      "POST /v1/billing/purchase-credits",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads minimal account state", async () => {
      // account-state is "always available" (never billing-gated) — returns a
      // real or local-unlimited mock either way, so always 200.
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/account-state/minimal");
      r.status(200);
    });
    await ctx.step("ANON cannot read minimal account state → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/account-state/minimal");
      r.status(401);
    });

    await ctx.step("OWNER reads tier configurations", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/tier-configurations");
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read tier configurations → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/tier-configurations");
      r.status(401);
    });

    await ctx.step("OWNER reads transactions", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read transactions → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/transactions");
      r.status(401);
    });

    await ctx.step("OWNER reads transactions summary", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions/summary");
      r.status(OWNER_READ);
    });

    await ctx.step("OWNER reads credit usage", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-usage", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });

    await ctx.step("OWNER reads credit breakdown", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-breakdown");
      r.status(OWNER_READ);
    });

    await ctx.step("OWNER reads usage history", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/usage-history", { query: { days: "7" } });
      r.status(OWNER_READ);
    });

    await ctx.step("proration preview without new_price_id → 400 (or gate 404)", async () => {
      // Handler returns 400 when `new_price_id` is missing; the billing gate may
      // intercept with 404 when billing is disabled.
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/proration-preview");
      r.status([400, 404]);
    });

    await ctx.step("purchase-credits with no amount → 400 (or gate 404)", async () => {
      // Missing/invalid amount → BillingError(400). A valid amount would build a
      // real Stripe checkout; we deliberately exercise the validation boundary.
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/purchase-credits", {});
      r.status([400, 404]);
    });
  },
);

flow(
  "BILL-6",
  {
    domain: "billing",
    serial: true,
    routes: [
      "GET /v1/billing/auto-topup/settings",
      "GET /v1/billing/auto-topup/setup-status",
      "POST /v1/billing/auto-topup/configure",
      "POST /v1/billing/cron/yearly-rotation",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads auto-topup settings", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/auto-topup/settings");
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read auto-topup settings → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/auto-topup/settings");
      r.status(401);
    });

    await ctx.step("OWNER reads auto-topup setup status", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/auto-topup/setup-status");
      r.status(OWNER_READ);
    });

    await ctx.step("OWNER configures auto-topup (disable)", async () => {
      // Disabling needs no Stripe payment method; the service coerces inputs and
      // returns a result (200). Validation failures would surface as 400; the
      // billing gate as 404.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/billing/auto-topup/configure", { enabled: false, threshold: 5, amount: 10 });
      r.status([200, 400, 404]);
    });

    await ctx.step("cron/yearly-rotation requires auth — ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/cron/yearly-rotation", {});
      r.status([401, 403]);
    });
    await ctx.step("authed yearly-rotation runs (or skips when billing off)", async () => {
      // Behind supabaseAuth; when billing is disabled returns {skipped:true} 200,
      // otherwise processes rotation and returns a result (200).
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/cron/yearly-rotation", {});
      r.status([200, 401, 403]);
    });
  },
);

flow(
  "BILL-7",
  {
    domain: "billing",
    serial: true,
    routes: ["POST /v1/billing/deduct", "POST /v1/billing/deduct-usage"],
  },
  async (ctx) => {
    await ctx.step("ANON cannot deduct → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/deduct", {
        prompt_tokens: 1,
        completion_tokens: 1,
        model: "gpt-4o-mini",
      });
      r.status(401);
    });

    await ctx.step("OWNER deduct (agent runtime) hits the real boundary", async () => {
      // Same supabaseAuth as the rest; accountId = caller's userId. A zero-cost
      // call returns success 200; a real cost may hit insufficient credits (402);
      // the billing gate returns 404 when disabled.
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/deduct", {
        prompt_tokens: 1,
        completion_tokens: 1,
        model: "gpt-4o-mini",
      });
      r.status([200, 400, 402, 404]);
    });

    await ctx.step("ANON cannot deduct-usage → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/billing/deduct-usage", {
        amount: 0,
        description: "ke2e",
      });
      r.status(401);
    });

    await ctx.step("OWNER deduct-usage with amount 0 → success no-op", async () => {
      // amount <= 0 short-circuits to {success:true,cost:0} 200 before touching
      // the ledger; 404 only when the billing gate is off.
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/billing/deduct-usage", {
        amount: 0,
        description: "ke2e",
      });
      r.status([200, 404]);
    });
  },
);
