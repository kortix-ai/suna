---
name: hubspot-hygiene
description: Nightly HubSpot CRM hygiene runbook for {{projectName}}. Finds and merges duplicate contacts, fills missing fields from enrichment data, flags stale deals, and gates any bulk field update over {{bulk_update_threshold}} records behind human approval.
---

<skill name="hubspot-hygiene">

<overview>
Keep HubSpot clean without a person babysitting it. A nightly cron spawns a
fresh session with scoped access to HubSpot and Clearbit. Each run dedupes
contacts, fills missing fields from enrichment data, flags deals that have
gone quiet, and posts what it did. Individual field fills write directly;
a bulk fill above the threshold stops for a human before it touches the CRM.

Proactive and schedule-driven; each run is self-contained — there is no
cross-run ledger to maintain.
</overview>

<when-to-load>
- The nightly cron fires the CRM hygiene sweep.
- A human asks the agent to clean up HubSpot, dedupe contacts, or check CRM
  data quality on demand.
</when-to-load>

<workflow>

## Step 0 — Confirm access

Nothing to resume — each run starts clean. Confirm the HubSpot and Clearbit
connectors are live before touching any records:

```
GET /crm/v3/objects/contacts?limit=1
GET /crm/v3/objects/deals?limit=1
```

If either connector fails, stop and report the failure in the summary
instead of running a partial sweep.

## Step 1 — Pull the working set

Pull contacts and open deals touched or created in the last 24h, plus any
contact record with a null in a required field:

```
GET /crm/v3/objects/contacts/search
  filterGroups: [{ propertyName: "lastmodifieddate", operator: "GTE", value: <24h ago> }]
GET /crm/v3/objects/contacts/search
  filterGroups: [{ propertyName: "jobtitle", operator: "NOT_HAS_PROPERTY" }, ...]
GET /crm/v3/objects/deals/search
  filterGroups: [{ propertyName: "dealstage", operator: "NEQ", value: "closedlost|closedwon" }]
```

## Step 2 — Find and merge duplicate contacts

Two contacts are the same record when they match on any of:

- Same primary email address.
- Same first + last name AND same company domain.

For each confirmed pair:

1. Pick the primary: the record with the older `createdate`, or the one with
   more associated deals/tickets if createdate ties.
2. Merge via HubSpot's contact merge endpoint so all associations (deals,
   tickets, notes, timeline) roll onto the primary.
3. If the two records disagree on a field HubSpot can't auto-resolve (e.g.
   conflicting job titles), keep the primary's value and note the conflict
   in the summary rather than guessing.

## Step 3 — Fill missing fields from enrichment

Required fields: `jobtitle`, `industry`, `numemployees` (company size). For
each contact missing one or more:

1. Query Clearbit by email or company domain.
2. If Clearbit returns a value, write it to the missing field.
3. Batch the writes for this pass. If the batch for a single field would
   touch **more than {{bulk_update_threshold}} records**, do not write it —
   go to Step 5 instead. Fills below the threshold write immediately,
   per-record.

## Step 4 — Flag stale deals

A deal is stale when it hasn't moved stage and has had no logged activity
(email, call, note, meeting) in **21+ days**. For each match:

- Set a `hygiene_stale` custom property (or tag) to `true` with the last
  activity date.
- Never change `dealstage`, never close the deal — flagging only.

## Step 5 — Human approval gate for bulk updates

When Step 3 produces a batch over {{bulk_update_threshold}} records:

1. Do not write any record in that batch.
2. Draft an approval request: field name, record count, and a sample of 5–10
   affected records with old → new values.
3. Post the request to {{alert_channel}} and wait. Apply the batch only after
   a human approves it in a later run; never retry-write without approval.

## Step 6 — Post the summary

Post one summary to {{alert_channel}} covering:

- Duplicate contacts merged (count + any unresolved conflicts).
- Fields filled from enrichment (count per field).
- Deals flagged stale (count, with links).
- Any bulk update pending approval, what it is, and why it's waiting.

</workflow>

<guardrails>
- **Bulk updates require approval.** Any single field-fill batch touching
  more than {{bulk_update_threshold}} records stops for a human before it
  writes — no exceptions.
- **Merge, never delete.** Duplicate resolution always merges into a primary
  record; a contact is never deleted outright.
- **Flag, never close.** Stale deals are marked for visibility; the agent
  never changes deal stage or closes a deal.
- **Scoped secrets.** HubSpot and Clearbit credentials are injected into the
  sandbox at runtime and never exposed to the model or written to logs.
- **No cross-run assumptions.** Each run re-derives duplicates, gaps, and
  stale deals from current HubSpot state rather than trusting a prior run's
  conclusions.
</guardrails>

</skill>
