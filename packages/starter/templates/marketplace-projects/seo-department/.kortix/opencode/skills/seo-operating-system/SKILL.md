---
name: seo-operating-system
description: Shared operating system for the SEO Department project: intake, data hierarchy, prioritization, memory, approvals, and reporting standards.
---

# SEO Operating System

Use this skill for every SEO Department task before applying a specialist SEO
skill.

## Intake

Clarify the smallest scope that can produce useful work:

- domain or URL set,
- market and language,
- audience and business goal,
- date range,
- known competitors,
- available data sources,
- whether output should be a plan, brief, audit, change request, or report.

If required context is missing, proceed with a clearly labeled assumption and
call out the data needed to improve confidence.

## Company Setup

When the project has just been installed or `.kortix/memory/SEO.md` is mostly
blank, run setup before doing strategy work. A company needs to bring its real
assets; this starter only provides the department's agents, skills, triggers,
and operating memory.

Read `install.md` first and follow its setup checklist. Collect these inputs in
one concise intake:

- primary public domain and canonical host,
- target market, language, and main conversion goals,
- website/app repository URL and default branch,
- framework or site stack if known,
- CMS, docs, blog, or content source,
- Google Search Console and analytics availability,
- priority product, landing, docs, blog, and comparison pages,
- competitor domains and protected brand terms,
- approval owner/channel for publishing, repo changes, and trigger enablement.

Finish setup in the current session. Do not start a separate specialist agent
session for install. Use specialist skills here, then tell the user which
future trigger or specialist will own each workflow after setup.

For every missing private integration, mint a setup link with
`request_secret` / `connect` or `kortix secrets request` /
`kortix connectors link`. Never ask the user to paste raw keys or tokens. Ask
for the repo connector early because technical SEO, repo monitoring, and safe
change requests are much better with source access.

If the company only gives a domain, still start with public evidence: sitemap,
robots, rendered pages, headings, metadata, schema, internal links, SERP
checks, and competitor research. Keep the repo/data gaps visible as setup tasks.

## Suna/Kortix-Style SEO Checks

For a Next.js or Suna/Kortix-style app, inspect the patterns this repo uses:

- canonical origin and global metadata helpers,
- `app/sitemap.ts` or sitemap generator,
- `public/robots.txt`,
- public SEO route groups, blog/use-case/docs routes, and RSS feeds,
- public-content records, markdown mirrors, AI/LLM-readable endpoints,
- canonical links, Open Graph metadata, structured data, and localized routes.

## Evidence hierarchy

Use sources in this order:

1. Connected first-party data: Search Console, analytics, CMS, repo, logs, CRM.
2. Live page evidence: rendered page, HTTP status, headers, sitemap, robots,
   structured data, internal links.
3. Current external research: SERP checks, competitor pages, public docs.
4. Reasoned estimates, clearly labeled as estimates.

Never fabricate rankings, clicks, impressions, conversions, crawl volume, or
revenue impact.

## Prioritization

Rank work by:

- expected business impact,
- confidence in evidence,
- implementation effort,
- risk,
- dependency on approvals or credentials.

Use priority labels:

- `P0`: search visibility is blocked or revenue-critical pages are broken.
- `P1`: material growth or risk reduction with clear evidence.
- `P2`: useful improvement, not urgent.
- `P3`: watch, backlog, or needs more data.

## Memory

Read `.kortix/memory/SEO.md` at the start. Update it only for durable facts:
strategy decisions, priority pages, competitor set, publishing policy, repo
structure, last reviewed repo commit, recurring issues, and backlog items that
should survive the session.

## Approval gates

Ask before publishing, changing production SEO controls, contacting external
sites, spending money, or making unsupported performance claims. Drafts, audits,
research, reports, and change requests are allowed.

## Output standard

End with a concise artifact:

- summary,
- evidence,
- ranked actions,
- owner or agent,
- approval needed,
- next check date when relevant.
