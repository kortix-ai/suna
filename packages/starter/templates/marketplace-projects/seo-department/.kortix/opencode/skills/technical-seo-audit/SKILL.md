---
name: technical-seo-audit
description: Runbook for technical SEO audits: crawlability, indexation, performance, structured data, internal links, and implementation-ready recommendations.
---

# Technical SEO Audit

Use this skill when checking a site, template, release, migration, or incident
for organic-search implementation risk.

## Audit sequence

1. Scope the audit: domain, URL sample, market, device, and date.
2. Crawl and fetch representative pages. Record status codes, redirects,
   canonical targets, noindex, robots directives, and sitemap presence.
3. Render important pages. Check title, meta description, h1, headings, body
   content, links, images, lazy-loaded content, and JavaScript-only content.
4. Check indexation signals: robots.txt, XML sitemaps, canonicals, hreflang,
   duplicate paths, parameter handling, pagination, and faceted navigation.
5. Check structured data. Validate schema type, required properties, duplicated
   entities, and mismatch between schema and visible content.
6. Check performance and page experience. Use available measurements first;
   otherwise collect page-level evidence and label it as a spot check.
7. Check internal links: orphaned priority pages, excessive depth, broken links,
   redirects in navigation, anchor clarity, and links from high-authority pages.
8. Produce a prioritized fix list.

## Severity rubric

- `Blocker`: important pages cannot be crawled, rendered, indexed, or resolved.
- `High`: material page group has canonical, redirect, schema, content, or
  internal-link problems likely to affect rankings.
- `Medium`: fix improves quality or crawl efficiency but is not blocking.
- `Low`: hygiene, monitoring, or backlog.

## Implementation guidance

If repository files are available and the fix is low risk, implement it and open
a change request with before/after evidence. For PR, push, migration, or release
reviews, also load `seo-repo-monitoring` so route, metadata, sitemap, robots,
redirect, schema, and rendering changes are checked against the repo-specific
risk model. For CMS or production-control changes, produce exact instructions
and ask for approval.

## Output

Return:

- affected URLs or templates,
- evidence,
- severity,
- recommended fix,
- owner,
- verification step,
- approval required or not.
