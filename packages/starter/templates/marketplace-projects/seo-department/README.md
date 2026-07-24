# SEO Department

A complete SEO department you can clone as a Kortix project. It comes with five
agents, five SEO-specific skills, persistent SEO memory, and a set of scheduled
workflows that cover the day-to-day operating rhythm of a serious organic growth
team.

## What you get

- **seo-director**: owns strategy, triage, reporting, prioritization, and
  approval gates.
- **technical-seo**: audits crawlability, indexation, schema, performance,
  sitemaps, robots, redirects, and internal links.
- **content-strategist**: turns keyword and performance signals into briefs,
  refresh plans, editorial backlog items, and publish-ready drafts.
- **serp-analyst**: watches competitors, SERP features, brand terms, snippets,
  and material ranking movement.
- **seo-repo-watchdog**: monitors PRs, pushes, route changes, metadata,
  schema, redirects, sitemaps, robots, content templates, and rendering changes
  for SEO regressions before they ship.
- **Schedules**: daily SERP watch, weekly technical audit, weekly content
  refresh, daily repo SEO sweep, monthly growth report, plus inbound request
  and repo webhooks.
- **Skills**: `seo-operating-system`, `technical-seo-audit`,
  `seo-repo-monitoring`, `content-seo-workflow`, and `serp-intelligence`.

## After cloning

1. Start the setup session. The installed files are the SEO department's
   operating system; your company still needs to bring its real website context.
   The setup agent reads `install.md` for the template-specific install guide.
2. Give the director the core inputs: primary domain, target market, website
   repository, default branch, CMS/content source, analytics/Search Console,
   priority pages, competitors, brand terms, and approval channel.
3. Connect the data sources you use: GitHub/repository access, Google Search
   Console, analytics, CMS, Slack/Teams, and any rank-tracking or crawl
   provider. Set `SEO_PRIMARY_DOMAIN`, `SEO_REPO_URL`, and
   `SEO_DEFAULT_BRANCH`.
4. Read `.kortix/memory/SEO.md` and fill in the starting ICP, priority markets,
   key product pages, and current SEO constraints.
5. Wire repository PR/push events to the `repo-seo-watch` webhook and set
   `SEO_REPO_WEBHOOK_SECRET` if you want automatic code review. Leave it off if
   you only want scheduled sweeps.
6. Turn on the triggers in `kortix.yaml` once the connectors are ready.
7. Ask the director for a kickoff: "Build the first 30-day SEO plan for our
   domain and tell me what needs approval."

## Company Intake

The first session should not be a blank chat. Ask the director to set up the SEO
department and it will request the repo and private data sources, mint setup
links for missing connectors/secrets, and fall back to a public-data audit if
some access is not ready yet. Setup happens in that same install session; the
specialist agents are future operating roles and trigger targets, not extra
setup sessions to spawn.

When adding this template into an existing project, the template files first
land through a change request. The installer should ask to apply that CR and,
after approval, start the first `seo-director` setup session from the merged
main branch instead of leaving the user to do that handoff manually.

## Safety model

The department can research, audit, draft, report, and open change requests by
default. It does not publish live content, change production SEO settings,
contact external sites for outreach, buy tools, or alter paid campaigns without
explicit approval or a project-level policy that says it may. The repo watchdog
can comment, report, draft fixes, and open change requests, but it never merges
or pushes directly to the default branch.
