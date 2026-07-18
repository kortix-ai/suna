---
name: lead-routing-rules
description: Runbook for scoring and routing a new HubSpot lead to the right rep for {{projectName}} — territory matching, segment specialists, the stateless round-robin pool, intent scoring, HubSpot property writes, Slack notifications, and when to escalate an ambiguous lead to a human instead of guessing.
---

<skill name="lead-routing-rules">

<overview>
Turn a new inbound lead into an assigned rep before it goes cold. A 15-minute
sweep reads HubSpot for leads on {{hubspot_lifecycle_stage}} that haven't been
routed yet, scores each for intent, matches it against the territory map and
segment specialists, and falls back to whichever rep in the round-robin pool
has taken the fewest leads so far this week. The assigned owner and the
reason are written back to HubSpot, the rep is notified in
{{routing_channel}}, and high-intent leads are called out distinctly. A lead
that doesn't clearly resolve — missing data, no matching rule, a genuine tie
— is never guessed at; it goes to {{escalation_channel}} for a human to
assign.

Fresh session per sweep — state lives on the HubSpot lead record itself (a
`kortix_routing_status` property + timestamp + reason marks a lead handled),
not in a local ledger file. The round-robin pool is stateless by design too:
"whose turn is it" is answered by counting each rep's current lead load in
HubSpot, not by a rotating pointer that would need to persist somewhere. A
single sweep can find several new leads at once; handle each as an
independent unit — a scoring or routing failure on one lead is logged and
skipped, and never blocks or corrupts routing for any other lead in the same
sweep.
</overview>

<when-to-load>
- The 15-minute routing sweep fires.
- A human asks the agent to route a specific lead, re-check HubSpot for new
  leads, or explain why a lead was routed where it was.
- The territory map, segment specialists, or round-robin pool changes and
  needs to be reflected in the next sweep.
</when-to-load>

<workflow>

## Step 0 — Orient: find what's new

Query HubSpot for contacts/leads on {{hubspot_lifecycle_stage}} that don't yet
carry the routing marker:

```
GET /crm/v3/objects/contacts/search
  filterGroups: [
    { propertyName: "lifecyclestage", operator: "EQ", value: "{{hubspot_lifecycle_stage}}" },
    { propertyName: "kortix_routing_status", operator: "NOT_HAS_PROPERTY" }
  ]
```

Anything already carrying `kortix_routing_status` (whether `routed` or
`flagged`) was handled by a prior run — skip it. A `flagged` lead stays
skipped until a human resolves it directly in HubSpot (assigning an owner
clears the need for another routing pass).

## Step 1 — Read the fields the routing rules need

Pull, per lead: country/region, company size, industry, deal/budget estimate
if present, job title, lead source, and any engagement data (page views,
email opens, form fields submitted). These are the inputs to territory
matching, segment matching, and intent scoring — a lead missing the fields a
rule needs can't be matched on that rule.

## Step 2 — Score intent

| Signal | High-intent if |
|---|---|
| Title | VP-level or above, or an explicit buyer/economic-decision-maker title |
| Company size | At or above the team's enterprise threshold in memory |
| Stated timeline/budget | Filled in and inside the current quarter |
| Engagement | Multiple pricing-page visits, a demo request, or a direct sales-contact form (vs. a passive newsletter signup) |

A lead is high-intent if it clears **two or more** of these. High-intent
status doesn't change who it's routed to — it changes how the notification is
flagged, so the assigned rep works it first.

## Step 3 — Match the territory map

Check the lead's region/country against the territory-to-rep map kept in
memory (e.g. "DACH → Rep A", "US-West → Rep B"). An exact match assigns that
rep. If the region maps to more than one rule (an overlap in the map itself)
or to no rule at all, this step doesn't resolve — move to Step 4.

## Step 4 — Match the segment specialists

If territory didn't resolve, check company size and industry against the
segment-to-specialist map in memory (e.g. "Enterprise (500+ employees) → Rep
C", "Mid-market SaaS → Rep D"). A match assigns that rep. No match — move to
Step 5.

## Step 5 — Fall back to the round-robin pool

If neither territory nor segment resolved, route within the general
round-robin pool defined in memory. Count each pool rep's leads currently
owned with a `kortix_routing_status` of `routed` and a creation date in the
current week; assign the new lead to whichever pool rep has the fewest. Ties
break alphabetically by rep name — this keeps the pool stateless and
reproducible without a rotating pointer to persist between sessions.

## Step 6 — Escalate what doesn't resolve

A lead escalates instead of being assigned when:

- The region, company size, and industry fields needed to check the map are
  all missing or unusable.
- The territory map itself has a genuine overlap or gap for this lead (a data
  problem in the map, not the lead).
- The round-robin pool is empty or every pool rep is marked unavailable in
  memory.

Post the lead to {{escalation_channel}} with what was checked and why it
didn't resolve. Set `kortix_routing_status = flagged` (with a timestamp and
reason) so it isn't re-flagged on the next sweep.

## Step 7 — Assign and write back

For a lead that resolved in Step 3, 4, or 5: set the HubSpot owner to the
matched rep, and write `kortix_routing_status = routed` with a timestamp and
the reason (e.g. "territory: US-West", "segment: enterprise", "round-robin:
fewest current leads"). These are the only fields this skill ever writes.

## Step 8 — Notify

Post to {{routing_channel}}: the lead (name, company, source), the assigned
rep, and the routing reason. If the lead scored high-intent in Step 2, mark
the notification clearly as high-intent so it's worked first. Escalated leads
get their own post in {{escalation_channel}} instead, never a silent skip.

</workflow>

<guardrails>
- **Never delete or merge.** This skill never removes a lead record or
  merges two records, under any circumstance — that action is entirely out of
  scope regardless of how confident a match is.
- **Writes are scoped to routing.** The only HubSpot writes are the owner
  field and the `kortix_routing_status` property (with its reason and
  timestamp). No other field, no bulk update, ever.
- **Ambiguous means escalate, never guess.** If territory, segment, and
  round-robin all fail to resolve cleanly, the lead goes to
  {{escalation_channel}} for a human — the agent never invents a fallback
  owner to close out the sweep.
- **No duplicate routing.** Always check `kortix_routing_status` before
  scoring or routing — a lead handled once (routed or flagged) is never
  reprocessed, even across many sweeps.
- **Round-robin is stateless.** "Whose turn it is" is computed fresh each
  sweep from each rep's current HubSpot lead count — never a pointer or
  counter that needs to survive between sessions.
- **Scoped secrets.** The HubSpot connector is brokered server-side at
  runtime; no raw credential is ever shown to the model or written to logs.
</guardrails>

</skill>
