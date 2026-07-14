---
name: personalized-outreach
description: Runbook for turning a new HubSpot lead in {{hubspot_list}} into a researched, personalized outbound sequence for {{projectName}}. Covers enrichment research, the outreach playbook (angles, proof points, what to avoid), sequence drafting, HubSpot logging, the daily cap, and the human approval gate before anything sends.
---

<skill name="personalized-outreach">

<overview>
Personalized outbound doesn't scale by hand, so a periodic sweep does the
research and the writing per contact instead. It reads HubSpot for contacts in
{{hubspot_list}} that haven't been handled yet, enriches each one, drafts a
first-touch and follow-up sequence grounded in the account's real context
using the angles and proof points in memory, logs every draft back to
HubSpot, and holds the batch in {{approval_channel}} for a person to approve
and send — capped at {{daily_cap}} contacts per run.

Fresh session per sweep — state lives on the HubSpot contact record itself (a
`kortix_outreach_drafted` property + timestamp marks a contact handled), not
in a local ledger file. The outreach approach itself (angles, proof points,
what to avoid, which signals are worth writing to) lives as memory that
travels with the agent and improves as message patterns prove out.
</overview>

<when-to-load>
- The periodic outreach sweep fires.
- A human asks the agent to run outreach against a specific list or contact.
- The outreach playbook (angles, proof points, what to avoid) changes and
  needs to be reflected in the next batch of drafts.
</when-to-load>

<workflow>

## Step 0 — Orient: find what's new

Query HubSpot for contacts in {{hubspot_list}} that don't yet carry the
drafted marker:

```
GET /crm/v3/objects/contacts/search
  filterGroups: [
    { propertyName: "list_membership", operator: "EQ", value: "{{hubspot_list}}" },
    { propertyName: "kortix_outreach_drafted", operator: "NOT_HAS_PROPERTY" }
  ]
  limit: {{daily_cap}}
```

Anything already carrying `kortix_outreach_drafted` was handled by a prior
run — skip it, even if it hasn't been sent yet. Sending is a human decision,
not a signal to re-draft. Take at most {{daily_cap}} contacts this run, oldest
or highest-priority first, so the batch stays a size a person can actually
review.

## Step 1 — Enrich each contact

Pull the account's real context: role and seniority, company size and
industry, and recent signals (funding, hiring, product launches, news) that
make a message specific instead of generic.

## Step 2 — Pick the angle

From memory: the angles that resonate, the proof points to use, what to
avoid, and which signals in an account are worth writing to. Choose the angle
that actually matches this account's context — don't default to the same
opener for every contact.

## Step 3 — Draft the sequence

Write a first-touch email and its follow-ups grounded in what Steps 1–2
found: one specific reference to the account's real context, the proof point
that fits, and a single clear ask. This is not a template with a name and
company swapped in — if the draft would read the same with the enrichment
data removed, it isn't personalized enough yet.

## Step 4 — Log the draft to HubSpot

Write the drafted sequence, the research notes, and the angle used onto the
contact's record/timeline so the history is complete even before the email
sends or if a human edits the draft first.

## Step 5 — Hold for approval, mark handled

Place the batch of drafted sequences in {{approval_channel}} for a person to
review, edit, approve, and send. Do not send anything yourself. Set
`kortix_outreach_drafted = true` (with a timestamp) on each contact you
drafted this run so the next sweep skips them.

</workflow>

<guardrails>
- **Never send.** Every sequence is a draft held in {{approval_channel}} for
  a human to review, edit, and send.
- **Daily cap.** Draft at most {{daily_cap}} new contacts per run, regardless
  of how large {{hubspot_list}} is — volume never outruns what a person can
  review.
- **HubSpot writes are scoped** to research notes, drafted sequence content,
  and the `kortix_outreach_drafted` marker. Never change deal stage,
  pipeline, or lifecycle stage.
- **No duplicate drafts.** Always check the `kortix_outreach_drafted` marker
  before researching or writing — a contact drafted once is never re-drafted,
  even across many sweeps.
- **Scoped secrets.** HubSpot and enrichment credentials are injected by the
  connector at runtime and never exposed to the model or written to logs.
</guardrails>

</skill>
