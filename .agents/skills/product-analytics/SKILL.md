---
name: product-analytics
description: "Kortix product analytics and campaign attribution in PostHog (EU Cloud): which events exist, where they fire (web or API), the privacy rules every event must keep, how a promo video or ad link must be tagged, and how to verify an event. Load before adding or renaming an analytics event, touching apps/web/src/lib/analytics or apps/api/src/shared/product-analytics.ts, preparing a campaign link, or answering \"where did our users come from\"."
---

# Product analytics

One PostHog project on EU Cloud collects kortix.com. The web app and the API
send to it with the same distinct id, the Supabase user id, so the browser
journey, the server events and the first-touch campaign meet on one person.

| Part | File |
|---|---|
| Hosts that report, consent, URL scrubbing | `apps/web/src/lib/analytics/posthog-config.ts` (+ `.test.ts`) |
| The browser client (init, consent switch, replay rules) | `apps/web/src/lib/analytics/posthog-client.ts` |
| Start, identify, per-page rules | `apps/web/src/components/analytics/posthog-host.tsx` |
| Browser events (closed list) | `apps/web/src/lib/track.ts` |
| Server events (closed list) | `apps/api/src/shared/product-analytics.ts` |
| Billing events as the account owner | `apps/api/src/billing/services/billing-analytics.ts` |
| Same-origin proxy `/ingest` | `apps/web/next.config.ts` rewrites |

## Rules

1. **No customer data in an event.** Properties are kinds, counts, USD amounts,
   our own route names and our own ids. Never a name, an email (except the one
   `identify` call), a prompt, a message, a file name, a title, a URL query or
   anything a customer typed. The CLAUDE.md PII rule applies to PostHog too.
2. **Every event name is in a closed list.** Web: `PANEL_EVENTS` or
   `JOURNEY_EVENTS` in `track.ts`. API: the `ProductEvent` union. Never call
   `posthog.capture` directly.
3. **A business fact is an API event.** Sign-up, project, session, message,
   checkout and payment events fire on the server after the database write. The
   browser loses events to ad blockers; the server does not.
4. **Only Kortix hosts report.** `kortix.com`, `staging.kortix.com` and
   `dev.kortix.com` send to the project; every event carries `environment`.
   A self-hosted, white-label or preview host never downloads posthog-js. The
   API sends only when `POSTHOG_PROJECT_KEY` is set.
5. **URLs are reduced before they leave the browser.** On signed-in and
   capability-token pages (`isAnalyticsExcludedPath`) a path becomes a route
   template (`/projects/:id/sessions/:id`). Only `utm_*` and ad click ids
   survive a query string. Autocapture text and link targets are removed on
   those pages.
6. **Consent decides storage.** Until the CookieYes banner grants analytics,
   the anonymous id lives in memory only (no cookie, no local storage). A grant
   switches to `localStorage+cookie`. Replays record only with that grant, only
   on public pages, never in the desktop app, with every input masked.
7. **Session replay is the expensive part.** It caused the December 2025 bill.
   Keep it limited to public pages and keep the billing cap in PostHog.

## Events

| Event | From | Fires when | Properties |
|---|---|---|---|
| `$pageview`, `$pageleave`, `$autocapture` | web | navigation, clicks | scrubbed URL, `environment`, `platform` (`web`/`desktop`), `app_version` |
| `cta_signup_clicked` | web | a sign-up button on a marketing page | `location` |
| `auth_completed` | web | the browser lands after sign-up or sign-in | `kind` (`signup`/`login`), `method` |
| panel events (`panel_opened`, …) | web (`@kortix/ui`) | session panel and conversation UI | `source`, `kind`, `count` |
| `account_created` | API | a new user's personal account is created | — |
| `project_created` | API | a project is provisioned or linked | `project_id`, `source`, `provider`, `from_marketplace`, `starter_template` |
| `session_created` | API | a person starts a session (not triggers, channels, agents) | `project_id`, `session_id`, `source`, `with_prompt` |
| `message_sent` | API | a person sends a prompt | `project_id`, `session_id` |
| `checkout_started` | API | a Stripe checkout is created | `kind` (`subscription`/`credits`), `amount_usd` |
| `subscription_started` | API | a paid plan becomes active (Stripe or app store) | `store`, `plan`, `amount_usd`, `billing_period` |
| `subscription_canceled` | API | a paid plan ends | `store`, `previous_tier`, `amount_usd` |
| `credits_purchased` | API | a one-off credit purchase is paid | `store`, `amount_usd` |
| `member_joined` | API | a user joins an account by invite | `via`, `role` |

API events that two code paths can report carry a fixed uuid (`dedupeKey`),
so PostHog stores one event.

## Campaign attribution

PostHog stores the first campaign a person arrived with as person properties
(`$initial_utm_source`, `$initial_utm_campaign`, `$initial_gclid`,
`$initial_fbclid`, `$initial_referring_domain`, …). Every later event, including
`subscription_started` from the API, can be broken down by them. Ad platforms
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
survey "How did you hear about us?" (shown once to new users) catches them;
its answers are in the survey's results and on the person.

## Verify an event

1. Local: put `NEXT_PUBLIC_POSTHOG_KEY=phc_…` in `apps/web/.env.local` (any
   localhost run reports as `environment=local` only with this variable).
2. In the browser console run `localStorage.setItem('ph_debug', 'true')` and
   reload: posthog-js logs every event with its properties before it sends it.
3. API: set `POSTHOG_PROJECT_KEY` in `apps/api/.env.local`, trigger the action,
   then find the event in PostHog → Activity, filtered on `environment = local`.
4. Production dashboards filter out `environment != production` through the
   project's test-account filter.
