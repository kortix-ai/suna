---
name: onboarding-milestones
description: Daily runbook for tracking new customer accounts against onboarding milestones in Postgres and HubSpot for {{projectName}}. Covers the milestone framework, stall and overdue detection, nudge drafting, the owning-CSM alert, and the human approval gate before anything sends or changes account state.
---

<skill name="onboarding-milestones">

<overview>
A new account's onboarding progress only matters if someone acts on a stall
while it's still cheap to fix. A daily sweep reads HubSpot for every account
inside its onboarding window, checks Postgres for that account's activation
milestones and product events, and classifies it as on track, stalled at a
specific milestone, or overdue for full activation. Every stalled or overdue
account gets a nudge email drafted to its specific missed step, and its
owning CSM gets an alert with the exact context. Nothing reaches the customer
and nothing on the account changes until a human reviews it.

Fresh session per sweep — state lives on the HubSpot account record itself (a
`kortix_onboarding_last_nudge_milestone` property marks the last milestone
nudged), not in a local ledger file. A sweep can find several accounts at
once; handle each as an independent unit — a failure checking one account's
milestones is logged and skipped, never blocking any other account in the
same sweep.
</overview>

<when-to-load>
- The daily onboarding sweep fires.
- A human asks the agent to check a specific account's onboarding status or
  re-run the sweep.
- The milestone framework (what counts as each step, expected timing, nudge
  tone) changes and needs to be reflected in the next run.
</when-to-load>

<workflow>

## Step 0 — Orient: find accounts inside the onboarding window

Query HubSpot for accounts (company or deal, whichever carries
`{{customer_since_property}}`) where that date falls within the last
`{{onboarding_window_days}}` days:

```
GET /crm/v3/objects/companies/search
  filterGroups: [
    { propertyName: "{{customer_since_property}}", operator: "GTE", value: <today - {{onboarding_window_days}}d> }
  ]
  properties: ["name", "hubspot_owner_id", "{{customer_since_property}}",
               "kortix_onboarding_last_nudge_milestone", "kortix_onboarding_last_nudge_at"]
```

For each match, resolve `hubspot_owner_id` to the owning CSM's name and note
how many days into onboarding the account currently is.

## Step 1 — Pull milestones and events from Postgres (read-only)

```sql
SELECT milestone, completed_at
FROM activation_milestones
WHERE account_id = :account_id
ORDER BY completed_at;

SELECT event_name, occurred_at
FROM product_events
WHERE account_id = :account_id
  AND occurred_at >= now() - interval '{{onboarding_window_days}} days'
ORDER BY occurred_at;
```

Adapt table and column names to what the project's schema actually calls
them; the shape above is illustrative. The milestone rows are the source of
truth for what's done — product events are supporting evidence for *why* a
milestone hasn't completed (e.g. zero logins vs. logins with no key action).

## Step 2 — Classify against the milestone framework

| Milestone | What it means | Expected by |
|---|---|---|
| Workspace live | First login after signup | Day 1 |
| Core setup | Key integration or configuration completed | Day 3 |
| First activation event | The core "aha" action completed — the first time the account got real value | Day 7 |
| Team expansion | A second teammate invited and active | Day 14 |
| Full activation | Recurring usage across most of the last 14 days | Day 30 (or `{{onboarding_window_days}}`) |

For each account:

- **On track** — every milestone whose expected day has passed is completed.
- **Stalled at `<milestone>`** — the account is past that milestone's
  expected day without completing it, but still inside the onboarding window.
- **Overdue** — past `{{onboarding_window_days}}` days total without full
  activation, regardless of which earlier milestones did complete.

An account can only be stalled at its *earliest* incomplete milestone — don't
report team expansion as the stall if core setup itself never finished.

## Step 3 — Draft the nudge (stalled or overdue accounts only)

Skip this step if `kortix_onboarding_last_nudge_milestone` already equals the
milestone this account is currently stalled at — it was nudged for this exact
stall on a prior run. Draft again only when the stalled milestone has changed
(the account moved past the previously-nudged one and is now stuck further
along, or regressed to an earlier open item) or the marker is missing.

Write the nudge addressed to the customer's specific missed step — not a
generic "how's it going" check-in:

- Name the one concrete action tied to the stalled milestone (e.g. "connect
  your first data source" for a core-setup stall, not "finish setup").
- Keep it short, helpful, and low-pressure — an offer to help, not a warning.
- Reference what the account has already done, if anything, so it doesn't
  read as a form letter to someone who's made partial progress.

Hold the draft in `{{draft_channel}}` for the owning CSM to review, edit, and
send.

## Step 4 — Alert the owning CSM

Post to `{{alert_channel}}`, addressed to the owning CSM, with:

- The account name and how many days into onboarding it is.
- Which milestones are completed and which is the current stall (or that it's
  overdue).
- The nudge that was drafted (or, if this exact stall was already nudged, a
  note that no new draft was made and the prior one is still pending).

This alert is **not** deduplicated — it reappears every day the account
remains stalled or overdue. It's a working reminder for the CSM, not a
one-time notice.

## Step 5 — Write the marker back

For every account that got a new nudge drafted in Step 3, set
`kortix_onboarding_last_nudge_milestone` to that milestone's name and
`kortix_onboarding_last_nudge_at` to now. This is the only HubSpot write —
never the deal stage, the owner, a plan, or a seat count.

</workflow>

<guardrails>
- **Draft and alert only.** The nudge email is always a draft in
  `{{draft_channel}}` for the owning CSM to review, edit, and send. The agent
  never emails the customer directly.
- **No account changes, ever.** The agent never changes a plan, a seat count,
  a billing setting, the deal stage, or the account owner — in HubSpot or any
  other system.
- **HubSpot writes are scoped** to `kortix_onboarding_last_nudge_milestone`
  and its timestamp. Nothing else on the record is touched.
- **No duplicate nudges for the same stall.** Always check
  `kortix_onboarding_last_nudge_milestone` before drafting — an account
  stalled at the same milestone as last run isn't re-nudged, though a change
  in which milestone it's stalled at always gets a fresh draft.
- **CSM alerts aren't deduplicated.** Unlike the nudge draft, the Slack alert
  reappears every day the account remains stalled or overdue — it's meant to
  be seen until someone acts.
- **Scoped secrets.** Postgres and HubSpot access is brokered server-side
  through connectors; no raw credential is ever shown to the model or written
  to logs.
</guardrails>

</skill>
