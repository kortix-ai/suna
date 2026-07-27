---
name: marketing-operating-system
description: Shared operating system for the Marketing Department project: intake, evidence hierarchy, prioritization, memory, approvals, and reporting standards.
---

# Marketing Operating System

Use this skill for every Marketing Department task before applying a specialist
marketing skill.

## Intake

Clarify the smallest scope that can produce useful work:

- business goal,
- audience, ICP, segment, or funnel stage,
- market and language,
- channel or asset type,
- deadline and launch context,
- available data sources,
- approval policy,
- desired output: plan, brief, calendar, draft, experiment, change request, or
  report.

If required context is missing, proceed with a clearly labeled assumption and
call out the data needed to improve confidence.

## Company Setup

When the project has just been installed or `.kortix/memory/MARKETING.md` is
mostly blank, run setup before doing strategy work. A company needs to bring its
real assets; this starter only provides the department's agents, skills,
triggers, and operating memory.

Read `install.md` first and follow its setup checklist. Collect these inputs in
one concise intake:

- primary domain and product/category,
- ICP, target markets, buyer personas, and conversion goals,
- positioning statement, message pillars, and proof points,
- primary channels and active campaigns,
- marketing website/app repository and default branch,
- CMS, docs, blog, or landing page source,
- analytics, CRM, email/lifecycle, ad, social, warehouse/BI availability,
- competitors and protected brand terms,
- approval owner/channel for publishing, sending, spend, repo changes, and
  trigger enablement.

Finish setup in the current session when the template is already on main. Do
not start a separate specialist agent session for install. If this is an
existing-project install whose files just landed through a CR, the installer
may start the first main-backed `marketing-director` setup session after the CR
is approved and merged.

For every missing private integration, mint a setup link with
`request_secret` / `connect` or `kortix secrets request` /
`kortix connectors link`. Never ask the user to paste raw keys or tokens. Ask
for the repo connector early because campaign landing pages, forms, analytics,
and safe change requests are much better with source access.

If the company only gives a domain, still start with public evidence: live site,
pricing/demo/signup/contact paths, messaging, content, social profiles,
competitors, and public launch/category context. Keep private data gaps visible
as setup tasks.

## Evidence Hierarchy

Use sources in this order:

1. Connected first-party data: analytics, CRM, warehouse, email/lifecycle, CMS,
   ad platforms, repo, logs.
2. Live customer-facing evidence: rendered pages, forms, metadata, tracking
   code, content, public social/profile pages.
3. Current external research: competitors, category pages, SERPs, social,
   communities, public docs.
4. Reasoned estimates, clearly labeled as estimates.

Never fabricate pipeline, revenue, attribution, conversion, spend, CAC, ROAS,
rankings, customer quotes, or lift.

## Prioritization

Rank work by:

- expected commercial impact,
- confidence in evidence,
- implementation effort,
- operational risk,
- dependency on approvals or credentials.

Use priority labels:

- `P0`: conversion, tracking, brand, spend, or launch risk is blocking or
  revenue-critical.
- `P1`: material growth or risk reduction with clear evidence.
- `P2`: useful improvement, not urgent.
- `P3`: watch, backlog, or needs more data.

## Memory

Read `.kortix/memory/MARKETING.md` at the start. Update it only for durable
facts: ICP, positioning, channels, approval policy, repo structure, campaigns,
last reviewed repo commit, reporting definitions, recurring risks, and backlog
items that should survive the session.

## Approval Gates

Ask before publishing, sending, spending, changing production tracking or
automations, contacting external parties, changing pricing/conversion flows, or
making unsupported performance claims. Drafts, audits, research, reports,
planning, and change requests are allowed.

## Output Standard

End with a concise artifact:

- summary,
- evidence,
- ranked actions,
- owner or agent,
- approval needed,
- next check date when relevant.
