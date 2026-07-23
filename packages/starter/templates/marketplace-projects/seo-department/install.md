# SEO Department Install Guide

Read this file before setting up the SEO Department. This guide is template
specific: it tells you how to turn the installed project files into a working
company SEO department.

## Goal

Do not ask the user to "give this project something to work on." The template
already installed the department's agents, skills, triggers, and memory. The
company still needs to connect its real website context: domain, repository,
analytics, Search Console, CMS/content source, competitors, approval channel,
and webhook secrets.

Your job is to guide the user all the way to a usable setup.

## Guided Setup Rule

The setup session created immediately after a new SEO Department project is
created is the install session. Complete setup in this current session. Do not
start another session just to install or configure the SEO Department.

If this template is being added into an existing project through a change
request, keep the flow guided: prepare the CR, ask the user whether to apply it,
merge it yourself when approved and permitted, then start the first main-backed
setup session with `seo-director`. Give the user a direct session link or use
the UI's Open session control for the session that just started. Do not end with
manual instructions like "merge this, then start a session" unless the current
grant prevents you from merging or starting sessions.

Specialist agents in this template are operating personas for future work and
trigger routing. During install, use their skills and checklists from this
setup session, then explain which specialist will own each future workflow.
Only recommend starting a separate session if the user explicitly asks to run a
large audit or content workflow after setup is complete, or if a just-merged
existing-project install needs the first `seo-director` session to boot from
main.

## First Response

Ask for everything needed in one structured intake. Do not ask one tiny question
at a time unless a single answer is blocking the next step.

Use this form:

```text
To finish setting up the SEO Department, send whatever you have for these:

1. Primary domain and canonical host:
2. Target market, language, and conversion goal:
3. Website/app repository URL or owner/repo:
4. Default production branch:
5. Framework/site stack if known:
6. Production URL and preview URL pattern, if different:
7. CMS, docs, blog, or content source:
8. Google Search Console site URL:
9. Analytics provider and property/project id:
10. Priority pages or URL groups:
11. Competitor domains:
12. Brand terms to protect:
13. Approval channel/owner for publishing and repo changes:
14. Report recipients:
15. Which automations should be enabled first:
    - inbound SEO request webhook
    - repo PR/push webhook
    - daily repo sweep
    - daily SERP watch
    - weekly technical audit
    - weekly content refresh
    - monthly growth report
```

Then explain that missing private access is normal and you will mint setup links
for it. Never ask the user to paste raw secrets in chat.

## Setup Links to Create

Use the `request_secret` / `connect` tools when available. Shell equivalents are
`kortix secrets request ...` and `kortix connectors link <slug>`.

Request these project values in as few links/messages as possible:

- `SEO_PRIMARY_DOMAIN`
- `SEO_TARGET_MARKET`
- `SEO_TRACKED_COMPETITORS`
- `SEO_BRAND_TERMS`
- `SEO_REPO_URL`
- `SEO_DEFAULT_BRANCH`
- `GSC_SITE_URL`
- `SEO_ANALYTICS_PROPERTY`
- `CONTENT_CMS_BASE_URL`
- `SEO_APPROVAL_CHANNEL`
- `SEO_REPORT_RECIPIENTS`
- `WEBHOOK_SEO_SECRET`
- `SEO_REPO_WEBHOOK_SECRET`

Connect private data sources as the company uses them:

- GitHub or repository access for the monitored website/app repo,
- Google Search Console,
- analytics provider,
- CMS/content system,
- Slack or Teams approval/reporting channel,
- rank tracking, crawler, or SEO platform if available.

If the project's agent grants do not yet expose a needed connector or secret,
explain the exact access needed and open a change request rather than asking for
broad access in chat.

## Configure Memory

After the user answers, update `.kortix/memory/SEO.md` with durable setup facts:

- primary domain and canonical host,
- target market and conversion goals,
- competitor domains and brand terms,
- website repo and default branch,
- framework, route roots, content roots, sitemap/robots owners,
- GSC/analytics/CMS availability,
- approval owner/channel,
- enabled/disabled trigger decisions,
- known setup gaps.

## Webhook Setup

Keep webhook triggers disabled until secrets and target behavior are confirmed.

### Inbound SEO Request Webhook

Use this for stakeholder requests from forms, Slack workflows, ticketing tools,
or internal systems.

1. Confirm `WEBHOOK_SEO_SECRET` is set.
2. Run `kortix triggers info seo-request-intake` and copy the `webhook_url`.
3. Configure the source system to `POST` JSON to that URL.
4. Sign the payload with the HMAC secret when the source supports it.
5. Test manually with `kortix triggers fire seo-request-intake`.
6. Enable only after the user approves: `kortix triggers enable seo-request-intake`.

### Repository PR/Push Webhook

Use this for GitHub PR and push events on the monitored website/app repository.

1. Confirm `SEO_REPO_URL`, `SEO_DEFAULT_BRANCH`, and
   `SEO_REPO_WEBHOOK_SECRET` are set.
2. Run `kortix triggers info repo-seo-watch` and copy the `webhook_url`.
3. In GitHub, open the monitored repo, then go to
   `Settings -> Webhooks -> Add webhook`.
4. Set Payload URL to the `repo-seo-watch` webhook URL.
5. Set Content type to `application/json`.
6. Set Secret to the value stored as `SEO_REPO_WEBHOOK_SECRET`.
7. Select at least Pull requests and Pushes. Add Releases if the company wants
   release checks.
8. Save the webhook and send a test delivery.
9. Confirm the agent treats all webhook fields as untrusted event data.
10. Enable only after the user approves: `kortix triggers enable repo-seo-watch`.

GitHub's `X-Hub-Signature-256` header is accepted by Kortix webhook triggers.

## Recommended Trigger Rollout

Enable automations in this order:

1. `daily-repo-seo-sweep`: safe read/report loop once repo access exists.
2. `weekly-technical-audit`: safe technical backlog and change requests.
3. `weekly-content-refresh`: once content source and approval policy are known.
4. `daily-serp-watch`: once competitors, market, and rank/SERP sources are known.
5. `monthly-seo-growth-report`: once reporting recipients and measurement
   sources are known.
6. `repo-seo-watch`: after webhook secret and GitHub test delivery work.
7. `seo-request-intake`: after the inbound source and routing policy are known.

For each trigger, tell the user what it will do, what data it can access, what
it will not do, and what approval gates apply.

## Public-Data Fallback

If the user only provides a domain, still produce useful work:

- fetch the live site,
- inspect robots, sitemap, canonical host, status codes, metadata, headings,
  schema, internal links, and page rendering,
- inspect public SERP/competitor context,
- produce a setup gap list and first 30-day SEO plan,
- mark all repo, GSC, analytics, and CMS findings as pending access.

## Completion Criteria

Setup is complete when:

- `.kortix/memory/SEO.md` contains the company baseline,
- required secrets/setup links have been requested,
- connected sources are verified or listed as pending,
- webhook URLs and GitHub setup steps have been given when webhooks are wanted,
- selected triggers are either enabled with approval or left disabled with a
  clear reason,
- the user receives a short "what now works / what is still missing" summary.
