# PostHog dashboards as code

Terraform definitions for the Kortix product-analytics dashboards in PostHog.
Applying this folder creates or updates 7 dashboards, their insights, and 4
conversion-goal actions in one PostHog project. Definitions live here; data
lives in PostHog.

| Dashboard | Answers |
| --- | --- |
| Kortix · Activation | Do new users reach a completed agent turn, and how fast? |
| Kortix · Engagement | DAU/WAU/MAU (any event and `prompt_sent`), stickiness, weekly retention, lifecycle, surface mix |
| Kortix · Providers & models | Which LLM providers get configured, whether keys verify, prompts and users by model |
| Kortix · Sessions | Session starts by provider, boot latency, active time by stop reason, turn outcomes and error rate |
| Kortix · Setup & adoption | Connectors, secrets, triggers, apps, feature flags, billing gates and the checkout funnel |
| Kortix · Acquisition | Visitors per day, referrers, UTM source/campaign, landing pages and bounce (sessions table), first-touch source of signups, visitor → signup |
| Kortix · Conversion | Goals per day (actions: Signed up, Activated, Subscribed, Topped up), visitor → paid funnel, signup → paid rate over time, checkout by tier, billing gate → top-up, time to paid |

The event names and properties are the server-side contract emitted by
`apps/api/src/lib/analytics.ts`. Change an event there, change the insight
here, in the same PR.

## Files

- `versions.tf` — provider `PostHog/posthog ~> 1.0`, configured from the environment.
- `dashboards.tf` — one `locals.dashboards` map; every insight is a PostHog
  query node (`InsightVizNode` → `TrendsQuery` / `FunnelsQuery` /
  `RetentionQuery` / `StickinessQuery` / `LifecycleQuery`). Three resources
  fan out from it: `posthog_dashboard`, `posthog_insight`,
  `posthog_dashboard_layout` (intro text tile, then insights two per row).
  `locals.goals` defines the conversion goals as `posthog_action` resources
  (one event each); the Conversion dashboard references them through
  `ActionsNode`, and they are selectable as Web analytics conversion goals.
  The Acquisition dashboard's landing-page and bounce tiles are HogQL
  (`DataTableNode` → `HogQLQuery`) over the `sessions` table.
- `.terraform.lock.hcl` — committed, pins the provider build.

## Apply

Requires Terraform ≥ 1.5 and a PostHog **personal API key** (Settings →
Account → Personal API keys) with scopes: `dashboard:write`, `insight:write`,
`cohort:write`, `action:write`, `alert:write`, `survey:write`,
`dashboard_template:read`, `organization:read`, `project:read`, `user:read`.

```sh
export POSTHOG_API_KEY=phx_...            # personal key, never commit it
export POSTHOG_HOST=https://us.posthog.com  # or https://eu.posthog.com
export POSTHOG_PROJECT_ID=595562            # Settings → Project → Project ID

terraform -chdir=infra/posthog init
terraform -chdir=infra/posthog plan
terraform -chdir=infra/posthog apply
```

State is local (`terraform.tfstate`, gitignored) until we decide on a remote
backend. Whoever applied last holds the state; do not apply from two machines
against the same project without moving the state first.

## Re-point at another project, organization, or region

Change `POSTHOG_HOST` and/or `POSTHOG_PROJECT_ID`, start from an empty state
(or a new `-state=` file), and `apply`. Everything in this folder is recreated
in the target project. **Events, persons, cohort membership and recordings do
not move** — only definitions do. A same-region project can also be moved
between organizations in the PostHog UI (owner or admin on both, source
organization needs two projects); a cross-region move (US → EU) needs the
Scale/Enterprise plan and PostHog support.

The web and API SDKs point at the same project through
`NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` and
`POSTHOG_API_KEY` / `POSTHOG_HOST`; change those in the same move.

## Bring a dashboard built in the UI under Terraform

1. Open the dashboard (or insight) in PostHog and click **Manage with
   Terraform** — it prints the HCL for the dashboard, its insights, layout,
   alerts and hog functions. Paste it into a new `.tf` file here.
2. Import the existing objects so Terraform adopts instead of recreates:

   ```sh
   terraform -chdir=infra/posthog import 'posthog_dashboard.example' 595562/<dashboard_id>
   terraform -chdir=infra/posthog import 'posthog_insight.example' 595562/<insight_id>
   ```

3. `plan` until it shows no changes, then commit.

Insights added to a dashboard by hand are kept but lose their layout on the
next apply: `posthog_dashboard_layout` is authoritative for tile positions and
deletes unmanaged text tiles. Add them here instead.

## Query notes

- Property math accepts `avg`, `sum`, `min`, `max`, `median`, `p75`, `p90`,
  `p99` — there is no `p50`/`p95`.
- `event = null` on an `EventsNode` means "all events".
- Formulas reference series by letter (`A/B*100`).
