// Plans, seats and Stripe. Two modes:
//   A. STRIPE_SECRET_KEY set: Checkout, the Customer Portal and a signed webhook.
//   B. unset (the local default): every firm is on a trial with LUMEN_TRIAL_SEATS
//      seats; operators change plans with `npx convex run billing:setPlan`.
// Stripe is called over its REST API with fetch: no SDK dependency.
// No price is written anywhere in Lumen's source: the pricing page reads Stripe.

import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { type MutationCtx, action, httpAction, internalMutation, internalQuery, query } from "./_generated/server";
import { requireFirm, requireFirmAdmin } from "./access";
import { audit } from "./audit";
import { plan as planV } from "./schema";

export type Plan = "trial" | "solo" | "team" | "firm";
const PAID: Exclude<Plan, "trial">[] = ["solo", "team", "firm"];

export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);
export const trialSeats = () => Number(process.env.LUMEN_TRIAL_SEATS) || 5;
const priceEnv = (p: Exclude<Plan, "trial">) => process.env[`STRIPE_PRICE_${p.toUpperCase()}`];

/** Seats in use for a firm, by its Better Auth organization. */
export const seatState = internalQuery({
  args: { orgId: v.string() },
  returns: v.union(v.null(), v.object({ seats: v.number(), members: v.number(), pending: v.number() })),
  handler: async (ctx, { orgId }) => {
    const firm = await ctx.db.query("firms").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
    if (!firm) return null;
    const use = await ctx.runQuery(components.betterAuth.membership.seatUse, { organizationId: orgId });
    return { seats: firm.seats, ...use };
  },
});

/** What the billing page shows. Members see it read-only. */
export const summary = query({
  args: { firmId: v.id("firms") },
  returns: v.object({
    mode: v.union(v.literal("stripe"), v.literal("off")),
    plan: planV,
    seats: v.number(),
    used: v.number(),
    pending: v.number(),
    billingStatus: v.string(),
    trialEndsAt: v.optional(v.number()),
    hasCustomer: v.boolean(),
  }),
  handler: async (ctx, { firmId }) => {
    const { firm } = await requireFirm(ctx, firmId);
    const use = await ctx.runQuery(components.betterAuth.membership.seatUse, { organizationId: firm.orgId });
    return {
      mode: stripeConfigured() ? ("stripe" as const) : ("off" as const),
      plan: firm.plan,
      seats: firm.seats,
      used: use.members,
      pending: use.pending,
      billingStatus: firm.billingStatus,
      trialEndsAt: firm.trialEndsAt,
      hasCustomer: Boolean(firm.stripeCustomerId),
    };
  },
});

/** Operator only (`npx convex run billing:setPlan '{"firmId":"…","plan":"team","seats":10}'`). */
export const setPlan = internalMutation({
  args: { firmId: v.id("firms"), plan: planV, seats: v.number() },
  returns: v.null(),
  handler: async (ctx, { firmId, plan, seats }) => {
    if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) throw new Error("400: seats must be 1-10000");
    const firm = await ctx.db.get(firmId);
    if (!firm) throw new Error("404: firm not found");
    await ctx.db.patch(firmId, { plan, seats });
    await audit(ctx, { firm, actorId: "operator", action: "billing.plan", detail: `${plan} × ${seats}` });
    return null;
  },
});

// ── Stripe ──

async function stripe<T>(method: "GET" | "POST", path: string, params?: Record<string, string>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("409: billing is not configured on this deployment");
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const query = method === "GET" && body ? `?${body}` : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? body : undefined,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`502: Stripe: ${json.error?.message ?? res.status}`);
  return json;
}

/** The plans as Stripe prices them, for /pricing. Null per plan when Stripe or that price is not set. */
export const prices = action({
  args: {},
  returns: v.object({
    mode: v.union(v.literal("stripe"), v.literal("off")),
    plans: v.record(v.string(), v.union(v.null(), v.object({ amount: v.number(), currency: v.string(), interval: v.string() }))),
  }),
  handler: async () => {
    if (!stripeConfigured()) return { mode: "off" as const, plans: {} };
    const plans: Record<string, { amount: number; currency: string; interval: string } | null> = {};
    for (const p of PAID) {
      const id = priceEnv(p);
      if (!id) { plans[p] = null; continue; }
      try {
        const price = await stripe<{ unit_amount: number; currency: string; recurring?: { interval: string } }>("GET", `prices/${id}`);
        plans[p] = { amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? "month" };
      } catch {
        plans[p] = null;
      }
    }
    return { mode: "stripe" as const, plans };
  },
});

export const forCheckout = internalQuery({
  args: { firmId: v.id("firms") },
  returns: v.object({ orgId: v.string(), userId: v.string(), stripeCustomerId: v.optional(v.string()) }),
  handler: async (ctx, { firmId }) => {
    const { firm, userId } = await requireFirmAdmin(ctx, firmId);
    return { orgId: firm.orgId, userId, stripeCustomerId: firm.stripeCustomerId };
  },
});

/** Admin: a Stripe Checkout Session for a plan and seat count. Returns the URL to send the browser to. */
export const checkout = action({
  args: { firmId: v.id("firms"), plan: v.union(v.literal("solo"), v.literal("team"), v.literal("firm")), seats: v.number() },
  returns: v.string(),
  handler: async (ctx, { firmId, plan, seats }): Promise<string> => {
    const f = await ctx.runQuery(internal.billing.forCheckout, { firmId });
    const price = priceEnv(plan);
    if (!price) throw new Error(`409: STRIPE_PRICE_${plan.toUpperCase()} is not set`);
    if (!Number.isInteger(seats) || seats < 1 || seats > 10_000) throw new Error("400: seats must be 1-10000");
    const site = process.env.SITE_URL ?? "";
    const session = await stripe<{ url: string }>("POST", "checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": String(seats),
      client_reference_id: firmId,
      "metadata[firmId]": firmId,
      "metadata[plan]": plan,
      "subscription_data[metadata][firmId]": firmId,
      "subscription_data[metadata][plan]": plan,
      success_url: `${site}/app/settings/billing?checkout=done`,
      cancel_url: `${site}/app/settings/billing`,
      ...(f.stripeCustomerId ? { customer: f.stripeCustomerId } : {}),
    });
    await ctx.runMutation(internal.billing.logCheckout, { firmId, actorId: f.userId, detail: `${plan} × ${seats}` });
    return session.url;
  },
});

export const logCheckout = internalMutation({
  args: { firmId: v.id("firms"), actorId: v.string(), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, { firmId, actorId, detail }) => {
    const firm = await ctx.db.get(firmId);
    if (firm) await audit(ctx, { firm, actorId, action: "billing.checkout", detail });
    return null;
  },
});

/** Admin: the Stripe Customer Portal (seats, card, cancel). */
export const portal = action({
  args: { firmId: v.id("firms") },
  returns: v.string(),
  handler: async (ctx, { firmId }): Promise<string> => {
    const f = await ctx.runQuery(internal.billing.forCheckout, { firmId });
    if (!f.stripeCustomerId) throw new Error("409: this firm has no subscription yet");
    const s = await stripe<{ url: string }>("POST", "billing_portal/sessions", {
      customer: f.stripeCustomerId,
      return_url: `${process.env.SITE_URL ?? ""}/app/settings/billing`,
    });
    return s.url;
  },
});

// ── Webhook ──

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Stripe's `Stripe-Signature` check: HMAC-SHA256 over `<t>.<payload>`, 5 min tolerance. */
export async function verifyStripeSignature(payload: string, header: string, secret: string, nowSec = Date.now() / 1000) {
  const pairs = header.split(",").map((p) => p.trim().split("=", 2));
  const t = pairs.find(([k]) => k === "t")?.[1];
  const sigs = pairs.filter(([k]) => k === "v1").map(([, s]) => s);
  if (!t || sigs.length === 0 || Math.abs(nowSec - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.includes(expected);
}

const STATUS: Record<string, "active" | "past_due" | "canceled"> = {
  active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled",
};

type StripeEvent = { id: string; type: string; data: { object: Record<string, any> } };

async function firmFor(ctx: MutationCtx, obj: Record<string, any>) {
  const id = obj.metadata?.firmId ?? obj.client_reference_id;
  const byId = id ? ctx.db.normalizeId("firms", id) : null;
  if (byId) return ctx.db.get(byId);
  if (typeof obj.customer !== "string") return null;
  return ctx.db.query("firms").withIndex("by_stripeCustomerId", (q) => q.eq("stripeCustomerId", obj.customer)).unique();
}

function planForPrice(priceId: string | undefined): Plan | null {
  return PAID.find((p) => priceEnv(p) && priceEnv(p) === priceId) ?? null;
}

/** Apply one verified Stripe event. Idempotent by event id. */
export const applyStripeEvent = internalMutation({
  args: { event: v.any() },
  returns: v.string(),
  handler: async (ctx, { event }) => {
    const e = event as StripeEvent;
    if (await ctx.db.query("stripeEvents").withIndex("by_eventId", (q) => q.eq("eventId", e.id)).unique()) return "duplicate";
    await ctx.db.insert("stripeEvents", { eventId: e.id });
    const obj = e.data.object;
    const firm = await firmFor(ctx, obj);
    if (!firm) return "no-firm";
    let patch: Record<string, unknown> | null = null;
    if (e.type === "checkout.session.completed") {
      patch = {
        stripeCustomerId: obj.customer ?? undefined,
        stripeSubscriptionId: obj.subscription ?? undefined,
        billingStatus: "active",
        ...(PAID.includes(obj.metadata?.plan) ? { plan: obj.metadata.plan } : {}),
      };
    } else if (e.type === "customer.subscription.created" || e.type === "customer.subscription.updated") {
      const item = obj.items?.data?.[0];
      const plan = planForPrice(item?.price?.id) ?? (PAID.includes(obj.metadata?.plan) ? obj.metadata.plan : null);
      patch = {
        stripeCustomerId: obj.customer,
        stripeSubscriptionId: obj.id,
        billingStatus: STATUS[obj.status] ?? "past_due",
        ...(plan ? { plan } : {}),
        ...(Number.isInteger(item?.quantity) ? { seats: item.quantity } : {}),
      };
    } else if (e.type === "customer.subscription.deleted") {
      patch = { billingStatus: "canceled" };
    }
    if (!patch) return "ignored";
    await ctx.db.patch(firm._id, patch);
    await audit(ctx, { firm, actorId: "stripe", action: "billing.plan", detail: `${e.type} ${e.id}` });
    return "applied";
  },
});

export const stripeWebhook = httpAction(async (ctx, req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("billing not configured", { status: 404 });
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature") ?? "", secret);
  if (!ok) return new Response("bad signature", { status: 400 });
  const result = await ctx.runMutation(internal.billing.applyStripeEvent, { event: JSON.parse(payload) });
  return Response.json({ result });
});
