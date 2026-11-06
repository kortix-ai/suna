# PostHog dashboards as code

Terraform definitions for the Kortix product-analytics dashboards in PostHog
EU Cloud, project `334925` ("Kortix"). Applying this folder creates or updates
7 dashboards, their insights, and 4 conversion-goal actions. Definitions live
here; data lives in PostHog. The event contract and the privacy rules are in
the `product-analytics` skill (`.agents/skills/product-analytics/SKILL.md`).

| Dashboard | Answers |
| --- | --- |
| Kortix · Activation | Do new users reach a completed agent turn, and how fast? |
| Kortix · Engagement | DAU/WAU/MAU (any event and `prompt_sent`), stickiness, weekly retention, lifecycle, surface mix |
| Kortix · Providers & models | Which LLM providers get configured, whether keys verify, prompts and users by model |
| Kortix · Sessions | Session starts by provider, boot latency, active time by stop reason, turn outcomes and error rate |
| Kortix · Setup & adoption | Connectors, secrets, triggers, apps, feature flags, billing gates and the checkout funnel |
| Kortix · Acquisition | Visitors, referrers, UTM source and campaign, landing pages and bounce, first-touch source of signups, visitor → signup |
| Kortix · Conversion | Goals per day (Signed up, Activated, Subscribed, Topped up), visitor → paid funnel, signup → paid rate, checkout by tier, billing gate → top-up, time to paid |

Every insight sets `filterTestAccounts`. The project's test-account filter
keeps `environment = production` and drops `@kortix.ai` / `@kortix.com`
people and the internal cohort, so local, dev and staging traffic never shows.

## Files

- `versions.tf`: provider `PostHog/posthog ~> 1.0`, configured from the environment.
- `backend.tf`: state in `s3://kortix-terraform-state-eu-west-2-935064898258/posthog/dashboards.tfstate`, S3 native locking.
- `dashboards.tf`: one `locals.dashboards` map. Three resources fan out from
  it: `posthog_dashboard`, `posthog_insight`, `posthog_dashboard_layout`
  (intro text tile, then insights two per row). `locals.goals` defines the
  conversion goals as `posthog_action` resources; the Conversion dashboard
  references them, and they are selectable as Web analytics goals.
- `.terraform.lock.hcl`: committed, pins the provider build.

## Apply

Needs Terraform ≥ 1.5, the AWS profile `kortix` (state bucket), and a PostHog
personal API key with `dashboard:write`, `insight:write`, `action:write`,
`cohort:write`, `alert:write`, `survey:write`, `dashboard_template:read`,
`organization:read`, `project:read`, `user:read`, `query:read`, scoped to
project 334925. Keep it in the gitignored `infra/posthog/.env.local`:

```sh
POSTHOG_API_KEY=phx_...
POSTHOG_HOST=https://eu.posthog.com
POSTHOG_PROJECT_ID=334925
```

```sh
set -a; . infra/posthog/.env.local; set +a
export AWS_PROFILE=kortix
terraform -chdir=infra/posthog init
terraform -chdir=infra/posthog plan
terraform -chdir=infra/posthog apply
```

## Bring a dashboard built in the UI under Terraform

1. Open the dashboard or insight in PostHog and click **Manage with
   Terraform**; paste the HCL into a `.tf` file here.
2. Import the existing objects so Terraform adopts them instead of recreating:
   `terraform -chdir=infra/posthog import 'posthog_dashboard.example' 334925/<dashboard_id>`.
3. `plan` until it shows no changes, then commit.

`posthog_dashboard_layout` owns tile positions: a tile added by hand to a
managed dashboard loses its position on the next apply. Add it here instead.

## Query notes

- Property math accepts `avg`, `sum`, `min`, `max`, `median`, `p75`, `p90`,
  `p99`; there is no `p50`/`p95`.
- `event = null` on an `EventsNode` means "all events".
- Formulas reference series by letter (`A/B*100`).
