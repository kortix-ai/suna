# Website Studio

An email-first web studio that runs itself. A client emails in, the **studio**
agent designs and deploys their website, sends a Stripe link to go live, and
then makes every future change by email for a small fee — on a heartbeat.

## What you get

- One agent — **studio** — that handles the whole loop: understand the request,
  build a real site, deploy a live preview, quote an adaptive monthly price,
  send a Stripe subscription link, promote to production on payment, connect or
  find a domain, and handle change requests by email.
- Two triggers (both **off by default**): an **inbound-email** webhook (the
  studio's front door) and a **heartbeat** cron (follows up on unpaid previews,
  checks live sites, reconciles the ledger).
- The skills it leans on, pulled in at clone time: `website-building`,
  `design-foundations`, `domain-research`.
- The full Kortix runtime floor (tools, plugins, memory) — same as any project.

## After cloning

1. Open the project and read `.kortix/opencode/agents/studio.md` — that's the
   whole workflow and the guardrails.
2. Connect the pieces (Customize → Connectors / Secrets): an **email** address
   the studio sends + receives from, **Stripe**, a **deploy** provider (Vercel),
   and optionally a **registrar**. Set `STUDIO_PRICE_FLOOR` /
   `STUDIO_PRICE_CEILING` / `STUDIO_DOMAIN_BUDGET`.
3. Wire your inbound address to the `inbound-email` trigger (or connect an email
   channel pointed at `studio`), then flip both triggers to `enabled: true`.
4. Send it a test email as if you were a prospect and watch it build.

## Guardrails (why it's safe to run)

The studio is autonomous on everything a **client** initiates, but it will not:

- contact a **new** prospect without you approving the target list *and* the
  copy first (and any approved outreach honours unsubscribe / CAN-SPAM / GDPR),
- spend money beyond `STUDIO_DOMAIN_BUDGET` or a configured cap without asking,
- ever auto-charge a card (it sends Stripe payment links / subscriptions the
  client chooses to pay).

See `docs/specs/2026-07-12-website-studio.md` for the full design.
