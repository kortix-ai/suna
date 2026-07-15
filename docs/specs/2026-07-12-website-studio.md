# Website Studio — an email-first, self-running web agency (spec)

**Status:** draft · **Date:** 2026-07-12 · **Owner:** Marko

## The idea

A Kortix project that operates a web design studio end-to-end, over email, with
almost no human in the loop. A prospect or client emails an address; the agent
figures out what they need, **designs and deploys a real website**, replies with
a live preview link and a **Stripe subscription** to activate it, and then makes
**every future change by email** for a small per-change fee. It runs on a
heartbeat: following up on unpaid previews, keeping live sites healthy, and
keeping its own books.

Pitch to the client, in the agent's words: *"I built you a website — here it is.
If you want it, it's $X/month, live in minutes. Any changes? Just reply and I'll
make them."* The email address **is** the product.

It ships as a one-click **`registry:project`** in the marketplace
(`packages/starter/templates/marketplace-projects/web-studio`) — clone it, connect
email + Stripe + a deploy provider, and it runs.

## Why this is a good Kortix demo

It exercises the whole platform in one loop: **triggers** (inbound-email webhook
+ heartbeat cron), **connectors/secrets** (email, Stripe, Vercel, a registrar),
**skills** (`website-building`, `design-foundations`, `domain-research`),
**memory** (the client ledger), and **the sandbox** (building/deploying real
sites). It's a believable autonomous business, not a toy.

## Lifecycle

```
        inbound email
             │
   ┌─────────▼──────────┐
   │  classify request  │  new? change? question? reply?
   └─────────┬──────────┘
     new     │              change
  ┌──────────▼───────┐   ┌───▼───────────────┐
  │ build real site  │   │ make change,      │
  │ → deploy preview │   │ redeploy, reply   │
  │ → adaptive quote │   │ + per-change      │
  │ → Stripe sub link│   │   Stripe link     │
  └──────────┬───────┘   └───────────────────┘
    paid     │
  ┌──────────▼──────────┐
  │ promote to prod     │
  │ connect / buy domain│  (buy only within budget, else ask)
  └─────────────────────┘

   heartbeat (every ~4h): remind unpaid previews once · verify live
   sites · reconcile ledger · flag anything needing a human
```

## Components

- **Agent `studio`** (`.kortix/opencode/agents/studio.md`) — the persona +
  workflow + guardrails.
- **Triggers** (in `kortix.yaml`, both disabled by default):
  - `inbound-email` (webhook) — every client message fires a session. Wired to
    an inbound address or an email channel pointed at `studio`.
  - `heartbeat` (cron, every 4h) — housekeeping only; never contacts new people
    or spends money.
- **Skills** (`registryDependencies`): `website-building`, `design-foundations`,
  `domain-research`.
- **Config** (`env.optional`): `STUDIO_FROM_EMAIL`, `STUDIO_PRICE_FLOOR`,
  `STUDIO_PRICE_CEILING`, `STUDIO_DOMAIN_BUDGET`.
- **Connectors to add after cloning:** email (send/receive), Stripe, a deploy
  provider (Vercel), optionally a registrar.

## Pricing

Always a **monthly subscription** that includes hosting + the site, priced
**adaptively** from the business context (a solo tradesperson vs. a regional
chain), clamped to `[STUDIO_PRICE_FLOOR, STUDIO_PRICE_CEILING]`. Change requests
are billed per request via their own Stripe payment link. The agent creates
Stripe **payment links / subscriptions** — it never auto-charges a card.

## Outbound lead-gen — human-approved only

The original vision included proactively finding leads (e.g. scraping Google My
Business listings for a niche via an Apify-style API) and cold-emailing them.
Because this template is **public and one-click-clonable**, unsolicited mass
outreach is deliberately **not** autonomous:

- The agent may **research and draft** a target list for a niche + region the
  operator specifies, then **stops and shows** the operator the list *and* the
  copy, and waits for explicit approval before anything sends.
- Approved sends must carry a real sender identity and a working unsubscribe,
  honour every prior opt-out, and comply with CAN-SPAM / GDPR / CASL. "Stop"
  means stop forever.
- No "every business in every country" blasting.

This keeps the fun, high-leverage part (find → pitch) available while making the
template safe to ship. The **inbound** fulfillment loop — everything a client
initiates — is fully autonomous.

## Guardrails (enforced in the persona)

1. Never contact a new prospect without approved list + copy.
2. Never spend money beyond `STUDIO_DOMAIN_BUDGET` / a configured cap without
   asking (domains, paid APIs, ads).
3. Never auto-charge a card — payment links only, client-initiated.
4. Reply only to people who emailed you, unless an outbound list was approved.
5. Keep the client ledger in `.kortix/memory/` (clients, sites, domains,
   subscription status, open changes, opt-outs); read it every session + heartbeat.

## Open questions / follow-ups

- Email wiring: ship with a concrete inbound provider recipe (channel vs. raw
  webhook + signature) rather than leaving it to the operator.
- A tiny `payments` reference skill (Stripe payment-link + subscription recipes)
  would sharpen step 2; today it's the Stripe connector via `kortix-executor`.
- Deploy provider is assumed Vercel; document the connector contract.
- Domain purchase flow via a registrar connector (propose → buy within budget).
