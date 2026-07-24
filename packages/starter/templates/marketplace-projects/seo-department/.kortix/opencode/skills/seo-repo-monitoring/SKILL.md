---
name: seo-repo-monitoring
description: Repo and PR monitoring runbook for SEO: route changes, metadata, sitemap/robots, canonicals, schema, redirects, content templates, and performance-sensitive code.
---

# SEO Repo Monitoring

Use this skill when reviewing a repository, pull request, push webhook, release
candidate, migration, or scheduled sweep for SEO impact.

## Scope

Start by identifying:

- repository and default branch,
- event type, branch, commit range, PR number, or release tag,
- changed files and affected URL patterns,
- primary domain, market, and priority page groups from `.kortix/memory/SEO.md`,
- whether the task needs a PR comment, change request, release note, or report.

If the repo connector is not available, ask for it with a setup link and still
produce a checklist the operator can run manually.

For a company install, remember that the SEO Department project repo may only
contain this department's configuration. The monitored website or product code
can be a separate repository. Ask for that website repo explicitly and store it
as `SEO_REPO_URL`; do not assume the current project repo is the site.

## High-Signal Files

Always inspect changed files matching these patterns:

- `app/**`, `pages/**`, `src/app/**`, `src/pages/**`, `routes/**`,
  `layouts/**`, `components/**`, `middleware.*`, `server/**`,
- `content/**`, `docs/**`, `blog/**`, `cms/**`, `collections/**`,
- `public/robots.txt`, `robots.txt`, `sitemap*`, `next-sitemap.config.*`,
  `metadata.*`, `seo.*`, `schema*`, `structured-data*`,
- `next.config.*`, `astro.config.*`, `nuxt.config.*`, `vite.config.*`,
  `remix.config.*`, `vercel.json`, `netlify.toml`, `_redirects`,
- `package.json`, lockfiles, image config, routing config, cache config, and
  build or deploy scripts that affect rendered pages.

Also inspect nearby helpers used by changed files: metadata factories,
canonical builders, route maps, slug utilities, CMS serializers, breadcrumb
builders, internal-link components, and schema emitters.

For Next.js or Suna/Kortix-style sites, look for:

- `src/lib/site-metadata.*`, `src/lib/seo/**`, public content registries, and
  canonical-origin constants,
- `app/sitemap.*`, `public/robots.txt`, RSS routes, `/markdown/**`,
  `/llms.txt`, `/llms-full.txt`, and `/api/ai`-style machine-readable content,
- grouped public route folders, localized routes, and dynamic content pages
  such as blog, docs, use cases, changelog, pricing, and comparison pages.

## Risk Model

Classify findings with these priorities:

- `P0`: important pages become blocked, removed, 404/5xx, noindexed,
  canonicalized to the wrong URL, omitted from sitemap, blocked by robots, or
  redirected incorrectly.
- `P1`: material groups lose unique titles, descriptions, h1s, schema,
  hreflang, indexable body content, internal links, or performance budget.
- `P2`: quality regressions such as weak snippets, duplicate metadata, missing
  alt text on important images, stale structured data, avoidable redirect
  chains, or crawl-waste increases.
- `P3`: hygiene, observability, naming, future monitoring, and backlog items.

Block only on `P0` with direct evidence. For `P1` and below, recommend fixes
and state whether the release can proceed.

## PR Review Sequence

1. Read the PR title, description, changed files, and commit range.
2. Build an affected-route map. For each changed route or template, infer the
   live URL pattern and priority page group.
3. Search for SEO controls touched directly or indirectly: robots, sitemap,
   canonical, metadata, schema, hreflang, redirects, internal links, content
   rendering, pagination, and status codes.
4. When a preview or local build is available, fetch/render representative
   pages and compare against expected SEO signals.
5. Comment only on material issues. Every comment needs evidence, affected
   files/URLs, priority, and a concrete fix.

## Push or Scheduled Sweep

For push events and sweeps:

1. Compare the new default branch state against the last reviewed commit in
   `.kortix/memory/SEO.md`.
2. Review changed high-signal files and any generated `robots.txt`, sitemap,
   redirects, schema, and route output.
3. Spot-check priority URLs on the live or preview domain if available.
4. Open a change request for safe source fixes. Otherwise, create a ticket-ready
   report and update the durable memory with the reviewed commit and recurring
   risks.

## Safe Actions

Allowed without extra approval:

- PR comments and repo sweep reports,
- source-level change requests for low-risk metadata/schema/internal-link fixes,
- test files, fixture updates, and monitoring documentation,
- memory updates about repo structure and reviewed commits.

Requires approval:

- direct writes to the default branch,
- production robots, canonical, redirect, sitemap, hreflang, or schema policy
  changes,
- mass URL migrations, content rewrites, or deletion of published pages,
- claims about traffic, rankings, revenue, or conversions without connected
  first-party data.

## Output

For PRs, return:

- verdict: pass, pass with notes, request changes, or blocked,
- affected routes or URL patterns,
- findings with priority, evidence, and file paths,
- exact recommended patch or owner-ready instruction,
- verification steps.

For sweeps, return:

- commit range reviewed,
- changes that matter for SEO,
- P0/P1 findings,
- safe fixes opened,
- backlog updates,
- next check date.
