---
name: marketing-repo-awareness
description: Marketing-site repository monitoring workflow for landing pages, forms, analytics, pixels, metadata, campaign URLs, and conversion regressions.
---

# Marketing Repo Awareness

Use this skill whenever marketing work touches a website/app repo, landing page,
tracking, forms, campaign URLs, conversion flows, pricing pages, or frontend
experiments.

## Repo Scope

Monitor the company's marketing website/app repo. Do not assume the current
Kortix project repo is the marketing site. Use:

- `MARKETING_REPO_URL`,
- `MARKETING_DEFAULT_BRANCH`,
- `.kortix/memory/MARKETING.md`,
- connector-provided repo data when available.

If repo context is missing, ask for it and produce a public-site fallback.

## High-Signal Files And Areas

Inspect:

- landing pages, pricing pages, homepage, comparison pages,
- signup/demo/contact forms,
- routes and redirects,
- analytics events, pixels, tag manager, consent, attribution, UTM parsing,
- metadata, Open Graph, schema, sitemap/robots when relevant,
- experiments, feature flags, personalization,
- performance-sensitive rendering and third-party scripts,
- content templates and CMS bindings.

## Review Output

For each issue:

- severity (`P0` to `P3`),
- affected route or funnel step,
- business risk,
- evidence,
- exact file/line when available,
- safe fix or owner,
- verification steps,
- approval needed.

## Change Requests

Open change requests for safe, reversible repo fixes. Do not directly merge or
push to the default branch. Ask before changing production tracking, pricing,
forms, checkout/signup/demo flows, paid pixels, or redirects.

## Ledger

When reviewing a default-branch sweep, update `.kortix/memory/MARKETING.md` with
the last reviewed commit and durable recurring risks.
