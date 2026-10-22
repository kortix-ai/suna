/**
 * Billing — reads, credits, transactions, and auto-topup. Maps to spec §20:
 *   BILL-5  → transactions, purchase-credits
 *   BILL-6  → auto-topup settings/setup-status/configure
 *
 * NOTE on status SETS: every protected billing route sits behind `supabaseAuth`
 * (ANON → 401) AND a billing-enabled gate (when billing is disabled the gate
 * short-circuits with 404 / `{skipped:true}`). The reads otherwise return 200
 * for the OWNER against their own/team account. So OWNER reads assert the
 * permissive [200, 404] set (404 only when the deployment runs with billing
 * off); ANON asserts 401. No mocking — codes are pinned from the handlers in
 * apps/api/src/billing/routes/.
 */
import { flow } from "../core/flow";
import { withDb } from "../fixtures/chat";

// OWNER reads succeed (200) on a billing-enabled deployment; 404 when the
// billing internal gate is disabled (self-hosted / local).
const OWNER_READ = [200, 404];

flow(
  "BILL-5",
  {
    domain: "billing",
    tags: ["smoke"],
    routes: [
      "GET /v1/billing/transactions",
      "POST /v1/billing/purchase-credits",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads transactions", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read transactions → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/transactions");
      r.status(401);
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
  },
);

// BILL-14 — five more account-scoped reads (credits.ts + payments.ts). All
// sit behind the same supabaseAuth + billing-enabled gate as BILL-5/BILL-6:
// OWNER_READ ([200,404]) on their own account, ANON → 401. tier-configurations
// is NOT public — billingApp's auth middleware only skips /account-state,
// /webhooks, and /cron/, so it's supabaseAuth-gated like every other route here.
flow(
  "BILL-14",
  {
    domain: "billing",
    routes: [
      "GET /v1/billing/credit-breakdown",
      "GET /v1/billing/credit-usage",
      "GET /v1/billing/tier-configurations",
      "GET /v1/billing/transactions/summary",
      "GET /v1/billing/usage-history",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER reads the credit balance breakdown", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-breakdown");
      r.status(OWNER_READ);
    });
    await ctx.step("a team member with no credit row of their own reads an all-zero breakdown, not an error", async () => {
      const team = await ctx.fixtures.team();
      const member = await team.addMember("member");
      const r = await ctx.client.as(member).get("/v1/billing/credit-breakdown");
      r.status(OWNER_READ);
      if (r.statusCode !== 200) return;
      r.body().has("$.total", 0).has("$.expiring", 0).has("$.non_expiring", 0).has("$.daily", 0);
    });
    await ctx.step("ANON cannot read the credit breakdown → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/credit-breakdown");
      r.status(401);
    });

    await ctx.step("OWNER reads a page of credit-usage records", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/credit-usage", { query: { limit: "5" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read credit-usage → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/credit-usage");
      r.status(401);
    });

    await ctx.step("OWNER reads the credits tier ladder ($50 … $50,000, 25 tiers) and the $50–$50,000 bounds", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/tier-configurations");
      r.status(OWNER_READ);
      if (r.statusCode !== 200) return;
      r.body()
        .has("$.tiers[0].name", "credits_50")
        .has("$.tiers[0].display_name", "5,000 credits")
        .has("$.tiers[0].monthly_price", 50)
        .has("$.tiers[3].monthly_price", 200)
        .has("$.tiers[24].monthly_price", 50000)
        .has("$.tiers[24].display_name", "5,000,000 credits")
        .has("$.tiers[25]", undefined)
        .has("$.min_monthly_usd", 50)
        .has("$.max_monthly_usd", 50000);
    });
    await ctx.step("ANON cannot read tier-configurations → 401 (auth-gated, not public)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/tier-configurations");
      r.status(401);
    });

    await ctx.step("OWNER reads the transaction summary window", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/transactions/summary", { query: { days: "30" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read the transaction summary → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/transactions/summary");
      r.status(401);
    });

    await ctx.step("OWNER reads the credit usage history summary", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/billing/usage-history", { query: { days: "30" } });
      r.status(OWNER_READ);
    });
    await ctx.step("ANON cannot read usage-history → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/billing/usage-history");
      r.status(401);
    });
  },
);

// BILL-15 — a team's balance is read through account_id (KRTX-2989). The two
// credit routes used the caller's personal account, so a team member saw their
// own zero balance as the team's, and a non-member could not be refused.
flow(
  "BILL-15",
  {
    domain: "billing",
    requires: ["database"],
    routes: ["GET /v1/billing/credit-breakdown", "GET /v1/billing/usage-history"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    await ctx.step("the team account holds a known balance", async () => {
      await withDb(ctx, (db) =>
        db.query(
          `INSERT INTO kortix.credit_accounts (account_id, balance_precise) VALUES ($1, 12.5)
           ON CONFLICT (account_id) DO UPDATE SET balance_precise = 12.5`,
          [team.id],
        ),
      );
    });
    await ctx.step("a team member reads the team's balance with account_id → 200, total 12.5", async () => {
      (await ctx.client.as(member).get("/v1/billing/credit-breakdown", { query: { account_id: team.id } }))
        .status(200)
        .body()
        .has("$.total", 12.5);
    });
    await ctx.step("a non-member naming the team → 403 on both routes", async () => {
      for (const path of ["/v1/billing/credit-breakdown", "/v1/billing/usage-history"]) {
        (await ctx.client.as(ctx.P.NONMEMBER).get(path, { query: { account_id: team.id } })).status(403);
      }
    });
  },
);

// BILL-21 — account-state shows money only to a caller IAM grants
// `billing.read` (pentest 2026-07 finding 1, BOLA). The route checked
// membership alone, so a member the engine refuses every account action (here:
// a password session in an account that enforces MFA) still read the whole
// subscription, balance and usage. It now reads the gating view only.
flow(
  "BILL-21",
  {
    domain: "billing",
    requires: ["database"],
    routes: ["GET /v1/billing/account-state", "GET /v1/billing/account-state/minimal"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const query = { account_id: team.id };
    const paths = ["/v1/billing/account-state", "/v1/billing/account-state/minimal"];
    await ctx.step("a plain member (billing.read) reads the full state with can_manage_billing false", async () => {
      for (const path of paths) {
        (await ctx.client.as(member).get(path, { query })).status(200).body().exists("$.credits.total").has("$.can_manage_billing", false);
      }
    });
    await ctx.step("the account enforces MFA", async () => {
      await withDb(ctx, (db) => db.query("UPDATE kortix.accounts SET mfa_required = true WHERE account_id = $1", [team.id]));
    });
    await ctx.step("the OWNER (super-admin) still reads the full state: subscription, balance, can_manage_billing true", async () => {
      for (const path of paths) {
        (await ctx.client.as(ctx.P.OWNER).get(path, { query }))
          .status(200)
          .body()
          .exists("$.subscription.status")
          .exists("$.credits.total")
          .has("$.can_manage_billing", true);
      }
    });
    await ctx.step("the member's aal1 session reads only the gating view on both routes", async () => {
      // IAM verdicts are cached for up to 15 s per member (IAM_CACHE_TTL_MS).
      const deadline = Date.now() + 20_000;
      for (const path of paths) {
        let body: Record<string, any> = {};
        for (;;) {
          const r = await ctx.client.as(member).get(path, { query });
          r.status(200);
          body = r.json<Record<string, any>>();
          if (!("total" in body.credits) || Date.now() > deadline) break;
          await new Promise((done) => setTimeout(done, 1_000));
        }
        const leaked = ["usage_this_period", "auto_topup", "contract", "enterprise_offer"].filter((k) => k in body);
        if ("total" in body.credits) leaked.push("credits.total");
        for (const k of ["subscription_id", "status", "monthly_usd", "commitment", "current_period_end"]) {
          if (k in body.subscription) leaked.push(`subscription.${k}`);
        }
        if (leaked.length) throw new Error(`${path} leaked without billing.read: ${leaked.join(", ")}`);
        if (typeof body.credits.can_run !== "boolean" || !body.tier?.entitlements || body.can_manage_billing !== false) {
          throw new Error(`${path} gating view is incomplete: ${JSON.stringify(body)}`);
        }
      }
    });
  },
);
