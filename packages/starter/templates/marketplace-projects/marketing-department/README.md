# Marketing Department

A complete marketing department you can clone as a Kortix project. It comes with
seven agents, seven marketing-specific skills, persistent marketing memory, and
scheduled workflows that cover the operating rhythm of a serious growth team.

## What you get

- **marketing-director**: owns strategy, priorities, reporting, approvals, and
  cross-functional coordination.
- **campaign-strategist**: turns launches and goals into campaign briefs,
  channel plans, timelines, dependencies, and measurement plans.
- **content-marketer**: manages editorial calendar, content briefs, refreshes,
  distribution, repurposing, and draft assets.
- **lifecycle-marketer**: plans email, nurture, onboarding, activation,
  reactivation, and customer expansion programs.
- **growth-analyst**: monitors performance, funnel movement, attribution,
  experiments, anomalies, and executive reporting.
- **brand-guardian**: maintains positioning, message consistency, competitor
  watch, narrative risks, and response drafts.
- **marketing-repo-watchdog**: reviews marketing-site and repo changes for
  landing pages, forms, analytics events, pixels, metadata, campaign URLs, and
  conversion regressions.
- **Schedules**: daily performance pulse, daily repo sweep, weekly campaign
  planning, weekly content calendar, weekly lifecycle review, weekly brand and
  competitor watch, monthly report, plus inbound request and repo webhooks.
- **Skills**: `marketing-operating-system`, `brand-positioning`,
  `campaign-strategy`, `content-engine`, `lifecycle-growth`,
  `marketing-analytics`, and `marketing-repo-awareness`.

## After cloning

1. Start the setup session. The installed files are the marketing department's
   operating system; your company still needs to bring its real context. The
   setup agent reads `install.md` for the template-specific install guide.
2. Give the director the core inputs: domain, ICP, positioning, target markets,
   channels, marketing repo, analytics/CRM/email/CMS/ad availability,
   competitors, approval owner, and reporting recipients.
3. Connect the data sources you use: GitHub/repository access, analytics, CRM,
   email/lifecycle, CMS, Slack/Teams, ad platforms, social platforms, and any
   BI or warehouse source.
4. Read `.kortix/memory/MARKETING.md` and fill in the baseline, priorities,
   policies, active campaigns, and setup gaps.
5. Wire PR/push events from the marketing site repo to `repo-marketing-watch`
   and set `MARKETING_REPO_WEBHOOK_SECRET` if you want code-aware marketing
   review. Leave it off if you only want scheduled sweeps.
6. Turn on triggers in `kortix.yaml` once connectors, secrets, and approval
   policies are ready.
7. Ask the director for a kickoff: "Build the first 30-day marketing plan and
   tell me what needs approval."

## Company Intake

The first session should not be a blank chat. Ask the director to set up the
Marketing Department and it will request the company context, repo, private data
sources, approval rules, and automation choices. It will mint setup links for
missing connectors/secrets and fall back to public-data planning if access is
not ready yet.

When adding this template into an existing project, the template files first
land through a change request. The installer should ask to apply that CR and,
after approval, start the first `marketing-director` setup session from the
merged main branch instead of leaving the user to do that handoff manually.

## Safety model

The department can research, audit, draft, report, plan, edit files, and open
change requests by default. It does not publish live content, send campaigns,
contact prospects/customers, change production lifecycle automations, alter paid
campaigns, spend money, or make unsupported performance claims without explicit
approval or a project-level policy that says it may.
