---
name: renewal-prep
description: Runbook for turning a HubSpot renewal date into a prepped packet and a drafted outreach email for {{projectName}}. Covers the 90/60/30-day windows, what belongs in a renewal packet, at-risk signals, Google Calendar cross-checking, and the human approval gate before anything sends or discounts.
---

<skill name="renewal-prep">

<overview>
A renewal date on a HubSpot deal is only useful if someone acts on it early. A
daily sweep reads every open deal's `{{renewal_date_property}}`, finds the
accounts crossing 90, 60, or 30 days out, builds a renewal packet — usage,
value delivered, and expansion ideas — checks Google Calendar for an existing
renewal conversation, and drafts the outreach. Anything that looks stalled,
shrinking, or gone quiet is flagged as at-risk in the same run. Nothing reaches
a customer and no discount is ever applied until the account owner reviews it.

Fresh session per sweep — state lives on the HubSpot deal record itself (a
`kortix_renewal_stage_alerted` property marks the last window surfaced), not
in a local ledger file. A sweep can find several accounts at once; handle each
as an independent unit — a failure preparing one account's packet is logged
and skipped, never blocking any other account in the same sweep.
</overview>

<when-to-load>
- The daily renewal sweep fires.
- A human asks the agent to check a specific account's renewal status or
  re-run the sweep.
- The renewal playbook (packet format, at-risk criteria, outreach tone)
  changes and needs to be reflected in the next run.
</when-to-load>

<workflow>

## Step 0 — Orient: find what crossed a window

Query HubSpot for open deals with `{{renewal_date_property}}` set:

```
GET /crm/v3/objects/deals/search
  filterGroups: [
    { propertyName: "{{renewal_date_property}}", operator: "LTE", value: <today + 90d> },
    { propertyName: "dealstage", operator: "NEQ", value: "closedlost" }
  ]
  properties: ["{{renewal_date_property}}", "amount", "dealstage", "hubspot_owner_id",
               "kortix_renewal_stage_alerted", "notes_last_updated", "hs_lastmodifieddate"]
```

For each deal, compute days-to-renewal and bucket it into 90 / 60 / 30. Skip a
deal if `kortix_renewal_stage_alerted` already equals that bucket — it was
packeted on a prior run. A deal moving into a *new*, tighter bucket (e.g. 90 →
60) always gets a fresh packet, since more has likely changed.

## Step 1 — Read the account's history

Pull the deal's notes, stage history, contract value, and the owner
(`hubspot_owner_id` → name). Read prior call and email activity to reconstruct
what's been delivered and discussed since the account signed or last renewed.

## Step 2 — Build the renewal packet

Assemble, in order:

1. **Usage and value delivered** — what the account has actually gotten out of
   the product since the last renewal, drawn from notes and activity, in
   concrete terms (not "engaged well" — the specific thing that shipped or
   got used).
2. **Expansion ideas** — one or two concrete, specific opportunities grounded
   in what this account does and hasn't used yet. Never a generic "consider
   upgrading" line.
3. **Contract terms** — current value, renewal date, and term length.

## Step 3 — Check Google Calendar (read-only)

Look for an existing renewal or QBR meeting near the renewal date. If one
exists, reference it in the draft ("ahead of our call on ...") instead of
proposing a new one. This is read-only — never create, move, or accept an
event.

## Step 4 — Flag at-risk signals

Independent of the 90/60/30 bucket, call out a deal as at-risk when it shows:

| Signal | What it means |
|---|---|
| Stage unchanged for an extended period | Deal has stalled |
| Contract value trending down vs. last term | Account may be scaling back |
| No logged activity in a long stretch | Relationship's gone quiet |
| Notes mentioning a competitor, budget freeze, or churn intent | Explicit risk |

At-risk deals get named specifically in {{alert_channel}}, with the signal
that triggered the flag — every day they remain at-risk, not just once.

## Step 5 — Draft the outreach

Write the renewal email using the packet: lead with the value delivered, name
the expansion idea if one fits naturally, and reference the scheduled
conversation if Step 3 found one. Hold it in {{draft_channel}} for the account
owner. Never send it, and never write a specific discount, credit, or price
change into the draft — if the account's situation calls for a pricing
conversation, say so in the packet and let the owner handle it.

## Step 6 — Post the radar

Post one summary to {{alert_channel}}: accounts newly crossing a 90/60/30
window (owner, renewal date, bucket), and the at-risk list with its signals.
This is the read summary; the packet and draft are the deliverables in
{{draft_channel}}.

## Step 7 — Write the marker back

Set `kortix_renewal_stage_alerted` on each packeted deal to the bucket just
surfaced (with a timestamp). This is the only HubSpot write — never the deal
stage, amount, or pipeline.

</workflow>

<guardrails>
- **Never send.** The renewal outreach is always a draft in {{draft_channel}}
  for the account owner to review, edit, and send.
- **Never discount.** The agent never applies, offers, or suggests a specific
  discount, credit, or price change. Pricing stays with the account owner.
- **Calendar is read-only.** Check for an existing conversation; never create,
  move, or accept an event.
- **HubSpot writes are scoped** to `kortix_renewal_stage_alerted`. Never
  change deal stage, amount, or pipeline.
- **No duplicate packets.** Always check `kortix_renewal_stage_alerted` before
  building a new packet — a deal already surfaced for its current bucket isn't
  re-packeted, though a move into a tighter bucket always gets a fresh one.
- **At-risk flags aren't deduplicated.** Unlike packets, an at-risk flag
  reappears every day the signal still holds — it's a nudge, not a one-time
  event.
- **Scoped secrets.** HubSpot and Google Calendar credentials are injected by
  the connector at runtime and never exposed to the model or written to logs.
</guardrails>

</skill>
