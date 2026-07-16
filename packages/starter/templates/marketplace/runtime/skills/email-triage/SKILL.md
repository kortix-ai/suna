---
name: email-triage
description: The shared-inbox triage runbook — how to read a new inbound email, label it, look up {{help_doc}} for a standard answer, draft a reply in Gmail or file a ticket in {{linear_team}}, and when to leave a thread label-only for a human.
---

<skill name="email-triage">

<overview>
Every inbound email in the shared inbox gets read, labelled, and routed to one
of three outcomes: a drafted reply, a filed Linear ticket, or a label-only
hold for a human. A scheduled check spawns a fresh session with scoped,
read/write access to Gmail and Linear and read access to {{help_doc}}; this
skill is the standard the triage is done to, so the agent doesn't reinvent
categories or tone on every run. A single check can turn up several new
messages at once — handle each as an independent unit: a failure or bad match
on one message never blocks triage of the others found in the same pass.
Nothing customer-facing ever sends from this skill — a draft is the most it
produces.
</overview>

<when-to-load>
- The scheduled inbox check fires and there is new inbound mail to triage.
- A human asks why a specific thread got the label, draft, or ticket it did.
- A human asks the agent to re-triage the current inbox on demand.
</when-to-load>

<workflow>

## Step 1 — Pull what's new

Check the shared Gmail inbox for messages that arrived since the last check
and don't already carry a triage label. Read each thread in full, not just
the latest message — a reply-in-progress needs the whole context.

## Step 2 — Categorize the message

Classify every thread into exactly one category:

| Category | Signal | Label |
|---|---|---|
| Support question | Asking how something works, a how-to, an account question with a known answer | `triage/support` |
| Bug report | Something broken, an error, unexpected behavior | `triage/bug` |
| Sales lead | Pricing, demo, or new-customer interest | `triage/sales` |
| Billing / invoice | Payment, invoice, or subscription question | `triage/billing` |
| Other / spam | Not a real request, or nothing the team needs to act on | `triage/other` |

Apply the label in Gmail regardless of what happens next — every message
that's triaged gets exactly one category label.

## Step 3 — Look up the help doc for support questions

For `triage/support`, search {{help_doc}} for the closest matching answer
before writing anything. Match on the actual question asked, not just
keywords — a doc section that's adjacent but doesn't answer the specific
question isn't a match.

| Match quality | Action |
|---|---|
| Doc directly answers the question | Draft a reply (Step 4) |
| Doc partially answers it, or the question combines two topics | Draft a reply covering what the doc supports; note in the draft what's uncertain |
| No relevant section in the doc | Label only — leave it for a human, don't guess |

## Step 4 — Draft the reply (never send)

Write the reply in the sender's language and tone: direct, helpful, answer
first. Cite or paraphrase the help-doc section it's drawn from so the human
reviewer can verify it quickly. Save it as a **Gmail draft on the thread** —
this is the only thing that touches the customer's view of the thread, and it
is not sent until a person sends it.

## Step 5 — File bug reports and follow-ups in Linear

For `triage/bug` and any `triage/support` thread that needs engineering
follow-up rather than a reply, create a ticket in the **{{linear_team}}**
team:

- Title: a short, specific summary of the reported problem.
- Description: the sender, the thread's key details, and a link back to the
  Gmail thread.
- Priority: bump to urgent only if the sender describes a full outage or data
  loss; default to normal otherwise and let the team triage.

Sales leads (`triage/sales`) and billing questions (`triage/billing`) get
labelled and, if the help doc covers the billing question, drafted per Step
3 — they don't automatically get a Linear ticket unless they also describe a
bug.

## Step 6 — Leave `triage/other` alone

Label and move on. No draft, no ticket, no further action.

## Step 7 — Stop

One pass over the new mail is one run. There's no ledger to update — the next
scheduled check re-reads whatever the inbox looks like then.

</workflow>

<guardrails>
- **Draft only, never send.** Every reply is a Gmail draft on the thread. The
  agent never sends a customer-facing email itself, no matter how confident
  the match to {{help_doc}} is.
- **No memory between runs.** Each check is a fresh session; the current
  inbox and label state is the only source of truth, not what a prior run
  concluded.
- **Don't guess past the doc.** If {{help_doc}} doesn't clearly answer a
  support question, label it and stop — a wrong drafted answer waiting for
  rubber-stamp approval is worse than no draft.
- **Scoped secrets.** Gmail, Linear, and help-doc access are brokered through
  connectors; no raw token is ever shown to the model or written to logs.
- **People decide, not the agent.** The agent labels, drafts, and files —
  whether a draft sends or a ticket's priority changes is a human call.
</guardrails>

</skill>
