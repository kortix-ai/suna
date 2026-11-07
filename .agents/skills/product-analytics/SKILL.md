---
name: product-analytics
description: "Kortix product analytics and campaign attribution in PostHog (EU Cloud): which events exist, where they fire (web or API), the privacy rules every event must keep, how a promo video or ad link must be tagged, and how to verify an event. Load before adding or renaming an analytics event, touching apps/web/src/lib/analytics or apps/api/src/shared/product-analytics.ts, preparing a campaign link, or answering \"where did our users come from\"."
---

# Product analytics

One PostHog project on EU Cloud collects kortix.com: **Kortix**, project
`334925` (https://eu.posthog.com/project/334925, free plan). The web app and
the API send to it with the same distinct id, the Supabase user id, so the
browser journey, the server events and the first-touch campaign meet on one
person.

| Part | File |
|---|---|
| Hosts that report, consent, URL scrubbing | `apps/web/src/lib/analytics/posthog-config.ts` (+ `.test.ts`) |
| The browser client (init, consent switch, masking) | `apps/web/src/lib/analytics/posthog-client.ts` |
| Start, identify, per-page rules | `apps/web/src/components/analytics/posthog-host.tsx` |
| Browser events (closed list) | `apps/web/src/lib/track.ts` |
| Server events (closed list) | `apps/api/src/shared/product-analytics.ts` |
| Events that know only the account (billing, trigger fires) | `apps/api/src/iam/account-analytics.ts` |
| Route events for the person behind a request | `apps/api/src/projects/routes/product-events.ts` |
| The request surface (`source`) | `apps/api/src/middleware/analytics-source.ts` |
| Dashboards as code | `infra/posthog/` |
| Same-origin proxy `/ingest` | `apps/web/next.config.ts` rewrites |

## Rules

1. **No customer data in an event.** Properties are kinds, counts, USD amounts,
   our own route names and our own ids. Never a name, an email, a prompt, a
   message, a file name, a title, a URL query, a trigger or connector slug, a
   secret name, or anything a customer typed. `identify` sends the user id
   only (decision 2026-11-04: data minimization). The CLAUDE.md PII rule
   applies to PostHog too.
2. **Every event name is in a closed list.** Web: `PANEL_EVENTS` or
   `JOURNEY_EVENTS` in `track.ts`. API: the `ProductEvent` union. Never call
   `posthog.capture` directly.
3. **A business fact is an API event.** Sign-up, project, session, message,
   checkout and payment events fire on the server after the database write. The
   browser loses events to ad blockers; the server does not.
4. **Only production reports** (decision 2026-11-06; the free plan has one
   project). The web client reports on `kortix.com` only; dev, staging, self-host,
   white-label and preview hosts never download posthog-js. The API sends only
   where `POSTHOG_PROJECT_KEY` is set: the prod blob, not dev or staging.
   Every event carries `environment`.
   A self-hosted, white-label or preview host never downloads posthog-js. The
   API sends only when `POSTHOG_PROJECT_KEY` is set.
5. **URLs are reduced before they leave the browser.** On signed-in and
   capability-token pages (`isAnalyticsExcludedPath`) a path becomes a route
   template (`/projects/:id/sessions/:id`). Only `utm_*` and ad click ids
   survive a query string. Autocapture text and link targets are removed on
   those pages.
6. **Consent decides storage.** Until the CookieYes banner grants analytics,
   the anonymous id lives in memory only (no cookie, no local storage). A grant
   switches to `localStorage+cookie`. A signed-in user without consent starts
   with their own user id (`bootstrap`), so no anonymous id is merged per page.
7. **No session replay** (decision 2026-11-04). The recorder is not bundled,
   and the project setting is off. Turning it on is a privacy-policy change.
8. **A person's events only.** Route events go through `capturePersonEvent`
   (`projects/routes/product-events.ts`): an agent's session token, an API
   key, a service account or an OAuth app sends nothing. Server-side session
   and turn events count only sessions with `initiator_type = member`.

## Events

| Event | From | Fires when | Properties |
|---|---|---|---|
| `$pageview`, `$pageleave`, `$autocapture` | web | navigation, clicks | scrubbed URL, `environment`, `platform` (`web`/`desktop`), `app_version` |
| `cta_signup_clicked` | web | a sign-up button on a marketing page | `location` |
| `auth_completed` | web | the browser lands after sign-up or sign-in | `kind` (`signup`/`login`), `method` |
| panel events (`panel_opened`, …) | web (`@kortix/ui`) | session panel and conversation UI | `source`, `kind`, `count` |
| `user_signed_up` | API | a new user's personal account is created | `method` (email, google, github, apple) |
| `user_logged_in` | API | a CLI device login or a headless sign-in (not a token refresh) | `method` |
| `project_created` | API | a project is provisioned or linked | `origin` (blank, template, marketplace, github_import), `provider` |
| `session_created` | API | a person creates a session (not triggers, channels, agents) | `session_id`, `source`, `with_prompt` |
| `session_started` | API | the session's runtime answers for the first time this boot | `provider`, `boot_ms` |
| `session_restarted` | API | a person restarts a session | `provider` |
| `session_stopped` | API | a person's session's sandbox stops | `reason`, `active_ms` |
| `prompt_sent` | API | a person sends a prompt | `model` (`default` = the project default), `attachment_count` |
| `turn_completed` | API | an agent turn of a person's session ends | `status` (ok, error, aborted), `end_reason`, `duration_ms` |
| `secret_created` | API | a new project secret (never its name or value) | `name_kind` (provider, other), `strategy` |
| `provider_configured` | API | an LLM provider is connected | `provider`, `method` (api_key, oauth, subscription) |
| `provider_verified` | API | a provider credential check | `provider`, `state` |
| `model_changed` | API | a person switches a session's model | `from`, `to`, `live_push` |
| `connector_added` | API | a connector is added (never its slug) | `provider`, `app` |
| `connector_connected` | API | a connector finishes connecting | `method`, `provider` |
| `trigger_created` | API | a trigger is created (never its slug) | `type` |
| `trigger_fired` | API | a trigger started or queued a run (account owner) | `fire_source`, `status`, `deduped` |
| `app_deployed` | API | an app deployment is queued | `app_kind`, `hosting_provider`, `actor_type` |
| `feature_flag_toggled` | API | a project feature flag is set or cleared | `key`, `enabled` |
| `billing_gate_hit` | API | a person is refused for billing | `reason`, `where` (session_create, session_start, prompt, model_switch) |
| `checkout_started` | API | a Stripe checkout is created | `kind`, `tier`, `amount_usd` |
| `subscription_activated` | API | a paid plan becomes active (Stripe or app store) | `tier`, `amount_usd`, `store`, `via` |
| `subscription_cancelled` | API | a paid plan ends | `store`, `previous_tier`, `amount_usd` |
| `credits_topped_up` | API | a one-off credit purchase is paid | `amount_usd`, `store` |
| `member_joined` | API | a user joins an account by invite | `via`, `role` |

Request-driven events carry `source` (web, cli, mobile, desktop). API events
that two code paths can report carry a fixed uuid (`dedupeKey`), and the
Stripe activation and credit grant report only when their keyed wallet grant
was not a replay.

## Campaign attribution

PostHog stores the first campaign a person arrived with as person properties
(`$initial_utm_source`, `$initial_utm_campaign`, `$initial_gclid`,
`$initial_fbclid`, `$initial_referring_domain`, …). Every later event, including
`subscription_activated` from the API, can be broken down by them. Ad platforms
that add a click id (`gclid`, `fbclid`, `msclkid`, `li_fat_id`, `ttclid`) need
no tagging beyond their own auto-tagging.

Tag every link we publish. Lowercase, `_` between words, no spaces:

| Parameter | Meaning | Example values |
|---|---|---|
| `utm_source` | where the link sits | `youtube`, `x`, `linkedin`, `instagram`, `tiktok`, `newsletter`, `podcast`, `producthunt` |
| `utm_medium` | the kind of placement | `video`, `social`, `paid_social`, `cpc`, `email`, `partner` |
| `utm_campaign` | the launch or campaign | `launch_2026_11`, `promo_video_1` |
| `utm_content` | the variant, when there are several | `cut_30s`, `thumbnail_b`, `pinned_comment` |

Examples:

- YouTube video description:
  `https://kortix.com/?utm_source=youtube&utm_medium=video&utm_campaign=promo_video_1`
- The same video's pinned comment:
  `…&utm_content=pinned_comment`
- A paid Meta ad: `?utm_source=meta&utm_medium=paid_social&utm_campaign=launch_2026_11&utm_content=cut_30s`

A viewer who types `kortix.com` by hand arrives as `$direct`. The PostHog
survey "Acquisition: how did you hear about us" catches them: one question,
shown once, 15 s after an app page (`/projects…`) loads, to people whose
`signed_up_at` is within 7 days. The answer is the event property
`$survey_response_709452a5-5925-4704-a85a-0618d2f78ed3` on `survey sent`.

## Where to look

The dashboards are code: `infra/posthog/` (Terraform, state in S3; see its
README). They follow the design of the closed PR #7144.

| Question | Dashboard |
|---|---|
| Do new users reach a completed turn, and how fast? | Kortix · Activation |
| DAU/WAU/MAU, retention, stickiness, surface mix | Kortix · Engagement |
| Providers, key checks, prompts by model | Kortix · Providers & models |
| Boot time, active time, turn outcomes | Kortix · Sessions |
| Connectors, secrets, triggers, apps, flags, billing gates | Kortix · Setup & adoption |
| Visitors, referrers, UTM, landing pages, first-touch signups, survey answers | Kortix · Acquisition |
| Goals, visitor → paid, signup → paid, time to paid | Kortix · Conversion |
| One person's journey | PostHog → People → the person → Events |

Every insight sets `filterTestAccounts`: `environment = production`, no
`@kortix.ai` / `@kortix.com` person, not the internal cohort. Local, dev and
staging events never reach the charts.

## PostHog project settings (set 2026-11-04)

- Session replay off. The recording domain (`https://kortix.com`), the 2 s
  minimum, console and network capture off and the private-path blocklist
  stay set, so turning it on later starts from safe settings.
- Surveys on. Authorized URL `https://kortix.com` (toolbar, heatmaps).
- IP anonymization on; GeoIP country and city still resolve.
- Free plan hard limits: 1 M events a month. Past it PostHog drops events until
  the next cycle; nothing is billed. Add a card and a billing limit before
  traffic approaches it.
- A survey created through the API with `start_date` keeps its targeting flag
  inactive. Activate the flag (`PATCH /api/projects/334925/feature_flags/<id>/
  {"active": true}`) or launch from the UI.

## Where the key lives

- Web: `POSTHOG_PROJECT_KEY` in `posthog-config.ts`, used on `kortix.com` only.
  No hosting setting is involved.
- API: `POSTHOG_PROJECT_KEY` in the prod Secrets Manager blob `kortix-prod-env`
  (eu-west-2), mirrored in `apps/api/.env.prod` (the dotenvx-secrets skill).
  `kortix-dev-env` and `kortix-staging-env` do not carry it (removed
  2026-11-06), so dev and staging send nothing. Unset = no server events.

## PostHog MCP

`claude mcp add --transport http posthog https://mcp.posthog.com/mcp -s user`,
then `/mcp` in Claude Code to log in (OAuth, picks the EU region). It answers
analytics questions and edits insights, dashboards and surveys directly.

## Verify an event

Never point a test at the Kortix project. Use your own free PostHog project,
or a local capture sink that logs what the API sends.

1. Web, local: put your own project's `NEXT_PUBLIC_POSTHOG_KEY=phc_…` in
   `apps/web/.env.local`. A localhost run reports only with this variable, as
   `environment=local`, and keeps bot traffic (scripted browsers) tagged
   `$browser_type: bot`.
2. In the browser console run `localStorage.setItem('ph_debug', 'true')` and
   reload: posthog-js logs every event with its properties before it sends it.
3. API, local: set `POSTHOG_PROJECT_KEY` (your project, or any `phc_` value)
   and `POSTHOG_HOST=http://localhost:<port>` (a sink that logs each `/batch/`
   body) in `apps/api/.env.local`, trigger the action, read the sink.
4. Production: PostHog → Activity, filter `environment = production`. The
   dashboards apply the project's test-account filter by default.
