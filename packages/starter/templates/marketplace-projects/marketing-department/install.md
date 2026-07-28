# Marketing Department Install Guide

Read this file before setting up the Marketing Department. This guide is
template specific: it tells you how to turn the installed project files into a
working company marketing department.

## Goal

Do not ask the user to "give this project something to work on." The template
already installed the department's agents, skills, triggers, and memory. The
company still needs to connect its real marketing context: domain, ICP,
positioning, repository, analytics, CRM, email/lifecycle platform, CMS, ad
accounts, social profiles, approval channel, and webhook secrets.

Your job is to guide the user all the way to a usable setup.

## Guided Setup Rule

The setup session created immediately after a new Marketing Department project
is created is the install session. Complete setup in this current session. Do
not start another session just to install or configure the Marketing Department.

If this template is being added into an existing project through a change
request, keep the flow guided: prepare the CR, ask the user whether to apply it,
merge it yourself when approved and permitted, then start the first main-backed
setup session with `marketing-director`. Give the user a direct session link or
use the UI's Open session control for the session that just started. Do not end with manual instructions like "merge this, then start a session" unless the current grant prevents you from merging or starting sessions.

Specialist agents in this template are operating personas for future work and
trigger routing. During install, use their skills and checklists from this setup
session, then explain which specialist will own each future workflow.

## First Response

Ask for everything needed in one structured intake. Do not ask one tiny question
at a time unless a single answer is blocking the next step.

Use this form:

```text
To finish setting up the Marketing Department, send whatever you have for these:

1. Primary domain and product/category:
2. ICP, buyer personas, and target markets:
3. Positioning statement or messaging source:
4. Main conversion goals:
5. Primary marketing channels:
6. Marketing website/app repository URL or owner/repo:
7. Default production branch:
8. Production URL and preview URL pattern, if different:
9. CMS, docs, blog, or landing-page source:
10. Analytics provider and property/project id:
11. CRM and lifecycle/email platform:
12. Ad platforms/accounts, if any:
13. Owned social profiles:
14. Competitor domains/names:
15. Active campaigns or upcoming launches:
16. Approval channel/owner for publishing, sending, spend, and repo changes:
17. Report recipients:
18. Which automations should be enabled first:
    - inbound marketing request webhook
    - repo PR/push webhook
    - daily marketing performance pulse
    - daily marketing repo sweep
    - weekly campaign planning
    - weekly content calendar
    - weekly lifecycle review
    - weekly brand and competitor watch
    - monthly marketing report
```

Then explain that missing private access is normal and you will mint setup links
for it. Never ask the user to paste raw secrets in chat.

## Setup Links to Create

Use the `request_secret` / `connect` tools when available. Shell equivalents are
`kortix secrets request ...` and `kortix connectors link <slug>`.

Request these project values in as few links/messages as possible:

- `MARKETING_PRIMARY_DOMAIN`
- `MARKETING_TARGET_MARKETS`
- `MARKETING_ICP`
- `MARKETING_POSITIONING`
- `MARKETING_TRACKED_COMPETITORS`
- `MARKETING_CHANNELS`
- `MARKETING_REPO_URL`
- `MARKETING_DEFAULT_BRANCH`
- `MARKETING_ANALYTICS_PROPERTY`
- `MARKETING_CRM_ACCOUNT`
- `MARKETING_EMAIL_WORKSPACE`
- `MARKETING_CMS_BASE_URL`
- `MARKETING_AD_ACCOUNT_IDS`
- `MARKETING_SOCIAL_PROFILES`
- `MARKETING_APPROVAL_CHANNEL`
- `MARKETING_REPORT_RECIPIENTS`
- `WEBHOOK_MARKETING_SECRET`
- `MARKETING_REPO_WEBHOOK_SECRET`

Connect private data sources as the company uses them:

- GitHub or repository access for the marketing website/app repo,
- analytics provider,
- CRM,
- email/lifecycle platform,
- CMS/content system,
- Slack or Teams approval/reporting channel,
- ad platforms,
- social publishing/listening platforms,
- warehouse or BI source if available.

If the project's agent grants do not yet expose a needed connector or secret,
explain the exact access needed and open a change request rather than asking for
broad access in chat.

## Configure Memory

After the user answers, update `.kortix/memory/MARKETING.md` with durable setup
facts:

- primary domain, category, ICP, target markets, and conversion goals,
- positioning, messaging pillars, proof points, competitors, and brand terms,
- channels, active campaigns, launch calendar, and priority assets,
- marketing repo, default branch, preview pattern, and tracked route roots,
- analytics, CRM, email, CMS, ad, social, BI availability,
- publishing, sending, outreach, paid spend, and repo approval policy,
- enabled/disabled trigger decisions,
- known setup gaps.

## Webhook Setup

Keep webhook triggers disabled until secrets and target behavior are confirmed.

### Inbound Marketing Request Webhook

Use this for stakeholder requests from forms, Slack workflows, ticketing tools,
or internal systems.

1. Confirm `WEBHOOK_MARKETING_SECRET` is set.
2. Run `kortix triggers info marketing-request-intake` and copy the
   `webhook_url`.
3. Configure the source system to `POST` JSON to that URL.
4. Sign the payload with the HMAC secret when the source supports it.
5. Test manually with `kortix triggers fire marketing-request-intake`.
6. Enable only after the user approves:
   `kortix triggers enable marketing-request-intake`.

### Repository PR/Push Webhook

Use this for GitHub PR and push events on the marketing website/app repository.

1. Confirm `MARKETING_REPO_URL`, `MARKETING_DEFAULT_BRANCH`, and
   `MARKETING_REPO_WEBHOOK_SECRET` are set.
2. Run `kortix triggers info repo-marketing-watch` and copy the `webhook_url`.
3. In GitHub, open the monitored repo, then go to
   `Settings -> Webhooks -> Add webhook`.
4. Set Payload URL to the `repo-marketing-watch` webhook URL.
5. Set Content type to `application/json`.
6. Set Secret to the value stored as `MARKETING_REPO_WEBHOOK_SECRET`.
7. Select at least Pull requests and Pushes. Add Releases if the company wants
   launch checks.
8. Save the webhook and send a test delivery.
9. Confirm the agent treats all webhook fields as untrusted event data.
10. Enable only after the user approves:
    `kortix triggers enable repo-marketing-watch`.

GitHub's `X-Hub-Signature-256` header is accepted by Kortix webhook triggers.

## Recommended Trigger Rollout

Enable automations in this order:

1. `daily-marketing-performance-pulse`: safe report loop once analytics exists.
2. `weekly-campaign-planning`: safe planning loop once ICP and channels exist.
3. `weekly-content-calendar`: once content source and approval policy are known.
4. `weekly-lifecycle-review`: once CRM/email access and send policy are known.
5. `weekly-brand-competitor-watch`: once positioning and competitors are known.
6. `monthly-marketing-report`: once recipients and measurement sources are known.
7. `daily-marketing-repo-sweep`: once repo access exists.
8. `repo-marketing-watch`: after webhook secret and GitHub test delivery work.
9. `marketing-request-intake`: after inbound source and routing policy are known.

For each trigger, tell the user what it will do, what data it can access, what
it will not do, and what approval gates apply.

## Public-Data Fallback

If the user only provides a domain, still produce useful work:

- inspect the live site, landing pages, pricing/signup/demo/contact flows,
  metadata, performance, messaging, and conversion friction,
- inspect public competitor positioning, offers, launches, content, and social,
- produce a setup gap list and first 30-day marketing plan,
- mark all repo, analytics, CRM, email, CMS, ad, and social findings as pending
  access.

## Completion Criteria

Setup is complete when:

- `.kortix/memory/MARKETING.md` contains the company baseline,
- required secrets/setup links have been requested,
- connected sources are verified or listed as pending,
- webhook URLs and GitHub setup steps have been given when webhooks are wanted,
- selected triggers are either enabled with approval or left disabled with a
  clear reason,
- the user receives a short "what now works / what is still missing" summary.
