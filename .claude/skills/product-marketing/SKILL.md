---
name: product-marketing
description: Creates and maintains the product marketing context doc at /product-marketing.md — the shared source other marketing skills (copywriting, cro, seo-audit, kortix-image) read first. Use when setting up, auto-drafting, updating, or checking product/marketing context.
---

# Product Marketing Context

Owns one artifact: **`/product-marketing.md`** — the product/marketing source of truth other skills load before they write anything. This skill creates it, keeps it current, and reports on it. It does **not** write campaigns, copy, or pages itself — it feeds the skills that do.

## File location

- **Primary:** `/product-marketing.md`

Always check all three before creating a new one, so you update the existing doc instead of duplicating it.

## Routing

Pick the mode from what the user asks:

| User intent | Mode |
| --- | --- |
| "set up / create product (marketing) context" | **Create** |
| "auto-draft from our codebase / site / materials" | **Auto-draft** |
| "update our context — we changed X" | **Update** |
| "do we have context set up? / is it there?" | **Status** |
| asks for actual copy, CRO, SEO, ads, images | **Defer** (see below) |

Casual phrasing counts — "make a product context doc for my app…" triggers this skill the same as a formal request.

## Create

1. Check the three locations. If a doc already exists, switch to **Update** instead of overwriting.
2. Offer two options:
   - **(1) Auto-draft from codebase (recommended)** — fast; fills what it can from existing materials.
   - **(2) Start from scratch** — walk the sections together.
3. If scratch: go **one section at a time**, conversationally — ask, confirm, move on. Never dump all the questions at once.
4. Write the result to `/product-marketing.md`.

## Auto-draft

1. Scan the repo/site for existing marketing signal: `README`, landing page copy, pricing page, about page, `<meta>` descriptions / OG tags, docs, and any existing positioning.
2. Draft each section from what you find.
3. **Flag every section that needs manual input** — anything you couldn't source confidently — rather than inventing it.
4. Present the full draft for review. Save to `/product-marketing.md` only after the user approves.

## Update

1. Read the existing doc.
2. From the change described, identify **only** the affected sections. Example — "new enterprise tier + VP of Engineering audience" touches: Target Audience, Personas (new persona), Product Overview (tier + its pricing), Objections (enterprise-specific), Competitive Landscape (enterprise rivals).
3. Edit those sections; **preserve everything else verbatim**. Pricing lives inside Product Overview, not a separate section.

## Status

1. Check `/product-marketing.md`.
2. Report whether it exists and **summarize its contents** if found.
3. If missing, offer to create it and explain the value: other skills (copywriting, cro, seo-audit, kortix-image, …) read this doc first so their output stays on-product and consistent.

## Sections

Cover the applicable ones — each is a heading in the doc.

1. **Product Overview** — what it is, category, key features, pricing/tiers.
2. **Target Audience** — who it's for (segments, company size, roles).
3. **Personas** — named buyer/user profiles, their jobs and pains.
4. **Problems You Solve** — the concrete problems and the cost of the status quo.
5. **Competitive Landscape** — alternatives and incumbents.
6. **Differentiation** — why you, not them.
7. **Objections** — what makes prospects hesitate, and the answers.
8. **Switching Dynamics** — what it takes to leave the current solution (cost, friction, triggers).
9. **Customer Language** — real words customers use, for copy that resonates.
10. **Brand Voice** — tone and style rules.
11. **Proof Points** — metrics, logos, testimonials, case studies.
12. **Goals** — what marketing is trying to achieve.

## Adapt to the business

Don't force all 12 sections.

- **B2B vs B2C:** B2C often needs lighter, less formal Personas and Switching Dynamics — skip what doesn't apply rather than padding it.
- **Early-stage / pre-launch:** Proof Points, Competitive Landscape, and Customer Language are often sparse. That's fine — say so and note they can be filled in as the business matures, rather than blocking on them.
- Match the questions to the model and stage (a B2B SaaS, a solo B2C mobile app, and an enterprise platform each need a different cut).

## Defer for execution tasks

If the user actually wants output — homepage copy, landing pages, CRO changes, SEO, ads, images — this is **not** the skill that produces it. Check for `/product-marketing.md` (and suggest creating one if it's missing), then hand off to the skill that owns the work (e.g. the copywriting skill for homepage copy). Don't generate that output using this skill's context-creation flow.
