---
name: lead-followup
description: Runbook for turning a new HubSpot lead into a researched, personalized follow-up email and a proposed call slot for {{projectName}}. Covers company research, the sales playbook (positioning, tone, qualifying questions), HubSpot record updates, Google Calendar availability, and the human approval gate before anything sends.
---

<skill name="lead-followup">

<overview>
Inbound leads convert on the follow-up that shows the company was actually
read, and that follow-up has to go out while the lead is still warm. A
periodic sweep reads HubSpot for leads on {{hubspot_pipeline}} that haven't
been handled yet, researches each company, drafts a personalized follow-up to
the sales playbook with one tailored qualifying question, checks Google
Calendar for a real opening and proposes that one slot, and writes the
research back onto the HubSpot record. Nothing reaches a lead until a human
reviews the draft in {{approval_channel}} and sends it.

Fresh session per sweep — state lives on the HubSpot lead record itself (a
`kortix_followup_drafted` property + timestamp marks a lead handled), not in a
local ledger file.
</overview>

<when-to-load>
- The periodic new-lead sweep fires.
- A human asks the agent to follow up on a specific lead or re-check HubSpot
  for new signups.
- The sales playbook (positioning, tone, qualifying questions) changes and
  needs to be reflected in the next drafts.
</when-to-load>

<workflow>

## Step 0 — Orient: find what's new

Query HubSpot for contacts/leads on {{hubspot_pipeline}} that don't yet carry
the drafted marker:

```
GET /crm/v3/objects/contacts/search
  filterGroups: [
    { propertyName: "lifecyclestage", operator: "EQ", value: "{{hubspot_pipeline}}" },
    { propertyName: "kortix_followup_drafted", operator: "NOT_HAS_PROPERTY" }
  ]
```

Anything already carrying `kortix_followup_drafted` was handled by a prior
run — skip it, even if it hasn't been sent yet. Sending is a human decision,
not a signal to re-draft.

## Step 1 — Read the lead record

Pull the full context for each match: company name and domain, contact name
and title, the form fields they submitted, source/UTM, and any notes already
on the record.

## Step 2 — Research the company

Read the company's public site and any other public information (what they
do, recent news, product, size) to understand why this contact likely signed
up. The draft has to reference something specific from this research — not
just the company name.

## Step 3 — Draft the follow-up to the playbook

Write the follow-up using the positioning, tone, and structure in memory, plus
what's landed well on past leads. Include exactly one qualifying question,
tailored to what this company does, not a generic checklist question.

## Step 4 — Propose a call slot

Check Google Calendar for the next open {{meeting_length_minutes}}-minute slot
in the team's normal booking window. Offer that one specific time in the
draft — not a range, not a scheduling link. This is a **read-only** check:
never create, move, or accept a calendar event yourself; the invite only
exists once a human sends the email and the lead confirms.

## Step 5 — Write research notes back to HubSpot

Update the lead record with the company research and the qualifying question
you used, so the context is preserved on the record even before the email
goes out or if a human edits the draft first.

## Step 6 — Hold for approval

Place the drafted follow-up in {{approval_channel}} as a draft only. Do not
send it. Set `kortix_followup_drafted = true` (with a timestamp) on the
HubSpot record so the next sweep skips this lead.

</workflow>

<guardrails>
- **Never send.** Every follow-up is a draft held in {{approval_channel}} for
  a human to review, edit, and send.
- **Calendar is read-only.** Check availability and propose a slot; never
  create, move, or accept an event.
- **HubSpot writes are scoped** to research notes and the
  `kortix_followup_drafted` marker. Never change deal stage, pipeline, or
  lifecycle stage.
- **No duplicate drafts.** Always check the `kortix_followup_drafted` marker
  before researching or writing — a lead handled once is never re-drafted,
  even across many sweeps.
- **Scoped secrets.** HubSpot and Google Calendar credentials are injected by
  the connector at runtime and never exposed to the model or written to logs.
</guardrails>

</skill>
