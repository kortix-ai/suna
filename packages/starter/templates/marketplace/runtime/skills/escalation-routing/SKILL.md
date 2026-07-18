---
name: escalation-routing
description: The 15-minute escalation-routing runbook for the Plain support queue — detecting SLA breaches against {{sla_targets}}, VIP accounts in {{vip_accounts}}, and high severity, routing each qualifying ticket to the right team, opening a linked issue in {{linear_team}} when engineering is needed, and posting the alert to {{escalation_channel}}. Never closes a ticket or promises a resolution.
---

<skill name="escalation-routing">

<overview>
Every open ticket in the Plain queue gets checked, every 15 minutes, against
three independent escalation criteria: an SLA breach, a VIP account, or high
severity. A qualifying ticket is routed to the right internal team, gets a
linked Linear issue when it's an engineering problem, and generates one alert
in the escalation Slack channel. A scheduled sweep spawns a fresh session with
scoped read/route access to Plain, write access to Linear, and post access to
Slack; this skill is the standard the routing is done to, so the agent doesn't
reinvent SLA math or severity judgment on every run. Nothing customer-facing
ever comes out of this skill — routing, a linked issue, and an internal alert
are the entire output.
</overview>

<when-to-load>
- The 15-minute escalation sweep fires.
- A human asks why a ticket did or didn't escalate.
- A human asks the agent to re-check the queue on demand.
</when-to-load>

<workflow>

## Step 1 — Pull the open queue

Read every open, unresolved ticket in Plain. This is a fresh session every
run, so pull the full current state of the queue — don't rely on which
tickets escalated last sweep, since a ticket's SLA clock, account, and
severity can all change between checks.

## Step 2 — Check each ticket against the three criteria

| Criteria | Signal | Source |
|---|---|---|
| SLA breach | First-response or resolution timer has passed the target for the ticket's tier | Ticket timestamps in Plain vs. {{sla_targets}} |
| VIP account | The ticket's account name or domain matches the VIP list | Plain customer/account field vs. {{vip_accounts}} |
| High severity | The ticket describes an outage, data loss, a security issue, or something blocking a paying customer's core workflow | Plain tags and ticket body |

Any single match qualifies the ticket for escalation. A ticket can match more
than one criterion — carry every matching reason into Step 5, don't collapse
to just one.

## Step 3 — Route to the right team

Tag or assign the qualifying ticket to the team that owns it:

| Ticket is about | Route to |
|---|---|
| A payment, invoice, or billing dispute | Billing / Finance |
| A security or data-handling concern | Security |
| An outage, bug, or product defect | Engineering (continue to Step 4) |
| A VIP account issue with no technical fault (relationship, contract, expectations) | Customer Success / Account team |

This tag-or-assign update is the only write the agent makes to the ticket
itself. It is never a status change, and it never closes or resolves the
ticket.

## Step 4 — Open a linked Linear issue when engineering is needed

Only for tickets routed to Engineering in Step 3 (outage, bug, product
defect). Before filing, check the ticket for an existing linked issue — never
open a duplicate for the same ticket.

Create the issue in **{{linear_team}}**:

- **Title** — a short, specific summary of the reported problem.
- **Description** — the account, the escalation reason(s) from Step 2, the
  relevant details or repro steps from the ticket, and a link back to the
  Plain ticket.
- **Priority** — Urgent for an active outage, data loss, or an already
  SLA-breached ticket; High for a VIP account with a real bug; Normal
  otherwise, and let the engineering team triage from there.

Attach the created issue's URL back onto the Plain ticket as an internal note
so the two records are linked in both directions.

## Step 5 — Post the alert

Post one message per qualifying ticket to **{{escalation_channel}}**: the
ticket link, the account name, every escalation reason that matched (SLA
breach / VIP / severity), the team it was routed to, and the linked Linear
issue URL if Step 4 created one.

## Step 6 — Stop

One pass over the current queue is one run. There is no ledger — the next
sweep, 15 minutes later, re-reads the queue's state at that point and starts
over.

</workflow>

<guardrails>
- **Route and alert, never resolve.** The agent tags, assigns, opens a linked
  issue, and posts an alert. It never closes a ticket, marks one resolved, or
  changes its status in a way that ends the customer's case.
- **No promises to the customer.** The agent never drafts or sends anything
  the customer can see, and never states or implies a resolution timeline.
  Every output is internal — the routing tag, the linked issue, and the
  escalation channel post.
- **One linked issue per engineering escalation.** Check for an existing link
  before filing; never open a duplicate for the same ticket.
- **Scoped secrets.** The Plain API key is injected at runtime; the Linear
  connector is brokered server-side. No raw credential is ever shown to the
  model or written to logs.
- **Fresh, no memory between runs.** Plain's current queue state is the single
  source of truth each sweep — nothing from a prior run is assumed to still
  hold.
</guardrails>

</skill>
