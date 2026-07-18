---
name: policy-qa
description: Triage loop for inbound HR policy questions. Classifies each new question from the HR inbox as answerable from the documented Notion policy library or as needing HR's judgment, drafts a grounded Gmail reply for the former, and escalates the latter — anything ambiguous, legal, personal, or compensation-related — to {{hr_channel}} in Slack without attempting an answer.
---

<skill name="policy-qa">

<overview>
Every 15 minutes, a fresh session checks the HR Gmail inbox for new employee
questions, searches the documented policy library in Notion for the answer,
and either drafts a grounded reply in Gmail for a human to send, or escalates
the question to HR in {{hr_channel}} on Slack when it's ambiguous, legal,
personal, or compensation-related. The agent never sends email itself and
never answers with anything the library doesn't already document.
</overview>

<when-to-load>
- The 15-minute cron fires the HR inbox check.
- A human asks the agent to check the HR inbox now, re-triage a specific
  thread, or explain why a question was escalated instead of answered.
</when-to-load>

<workflow>

## Step 1 — Pull new questions from the HR inbox (read-only)

Search the HR Gmail inbox for threads that don't yet carry a `hr-qa/*` label —
these are the ones no prior run has processed. Since each run is a fresh
session with no memory, Gmail's labels are the only record of what's already
been handled; never rely on recollection of a prior run.

## Step 2 — Classify the question

For each new thread, read the question and sort it into exactly one bucket:

| Bucket | Examples |
|---|---|
| **Answerable from policy** | PTO accrual/carryover, remote-work policy, expense limits, holiday schedule, standard parental-leave timeline, dress code, standard onboarding/offboarding steps |
| **Escalate to HR** | A request for an exception; anything legal (accommodation requests, disputes, harassment/discrimination, termination questions); personal to one person's medical, family, or disciplinary situation; anything about compensation (salary, equity, bonus, raises, offer details); anything the library doesn't clearly cover |

If a question could plausibly sit in either bucket, escalate it. Never guess
to avoid an escalation.

## Step 3 — Answer from the documented policy library (read-only)

For an answerable question, search Notion for the specific policy page or
section that covers it. Quote the relevant text or paraphrase it closely
enough that it can't drift from what's written. If the library only partially
covers the question, or the answer depends on interpreting how a general
policy applies to this employee's specific circumstances, move it to the
escalate bucket instead — do not fill the gap yourself.

## Step 4 — Draft the reply

Create a Gmail draft (never send) replying in the thread with:

- A direct answer to the question.
- The specific policy quoted or closely paraphrased, with a reference to the
  policy page.
- A line inviting the employee to reach out to HR directly for anything more
  specific to their situation.

Apply the label `hr-qa/drafted` to the thread.

## Step 5 — Escalate to HR

For an escalation, post to {{hr_channel}} in Slack:

- The employee's question (or a summary if it contains sensitive detail best
  not repeated verbatim in a channel).
- Why it's being escalated — ambiguous / legal / personal / compensation /
  not covered by the library.
- A link to the email thread.

Apply the label `hr-qa/escalated` to the thread. Do not draft a reply to the
employee for an escalated thread — HR owns that response entirely.

## Step 6 — One pass, no double-processing

Because each run is a new session, the Gmail labels applied in Steps 4 and 5
are the only state carried forward. Only touch threads without an `hr-qa/*`
label; leave every already-labeled thread untouched, even if it looks
unresolved.

</workflow>

<guardrails>
- **Documented policy only.** Never invent, infer, or extend a policy beyond
  what's written in the Notion library, and never grant or imply an exception.
- **Never send email.** Every reply is a Gmail draft; a human on HR sends it
  or doesn't.
- **Escalate, don't answer, anything ambiguous, legal, personal, or
  compensation-related.** These go to {{hr_channel}} with no attempted answer,
  every time, without exception.
- **Read-only into Notion.** The agent never edits the policy library.
- **No memory between runs.** Gmail labels are the sole state; nothing about
  a prior run is assumed or recalled.
- **Scoped secrets.** Gmail and Notion access is brokered through connectors;
  Slack posts go through the channel integration. No raw credential is shown
  to the model or written to logs.
</guardrails>

</skill>
