---
name: interview-scheduling
description: Daily interview-scheduling sweep for {{projectName}}. Reads {{greenhouse_pipeline}} for candidates ready to schedule and each one's interview plan, checks {{interviewer_calendars}} for panel availability, and drafts a candidate slot proposal plus a calendar invite per interviewer to {{coordinator_review_inbox}}. Never sends a proposal or invite and never makes a hiring decision; a coordinator confirms and sends everything.
---

<skill name="interview-scheduling">

<overview>
Coordinating an interview loop means combining two systems that don't talk to
each other: the interview plan — who's on the panel, which round, how long it
runs — lives in Greenhouse, and whether those people are actually free lives
in their calendars. A daily sweep reads both, proposes a time that works for
every panelist, and drafts the candidate-facing proposal and each
interviewer's invite.

Fresh session every run, no local ledger: the agent recomputes the batch from
{{greenhouse_pipeline}}'s current state and {{interviewer_calendars}}'s
current availability each time, so what "already scheduled" means is whatever
{{greenhouse_pipeline}} already shows for that candidate.
</overview>

<when-to-load>
- The daily scheduling cron fires.
- A human asks the agent to schedule or re-propose a specific candidate's
  next round.
- An interview plan or a panelist's availability changes and the prior
  proposal needs to be redrafted.
</when-to-load>

<workflow>

## Step 1 — Find candidates ready to schedule

Read {{greenhouse_pipeline}} for every candidate marked ready to schedule —
cleared their current stage and waiting on the next round — who doesn't
already have a drafted or confirmed proposal for that round. Skip anyone
already scheduled or already carrying an undrafted proposal from a prior run.

## Step 2 — Read the interview plan

For each candidate, pull the plan for their next round from
{{greenhouse_pipeline}}: which interviewers are on the panel, what the round
covers, and how long it's scheduled to run. This plan is the only source of
truth for who belongs on the invite — never add or drop a panelist on your
own judgment.

## Step 3 — Check the panel's real availability

Check every interviewer on the plan against {{interviewer_calendars}} for
open slots in the next several business days that fit the round's duration.
A slot only counts if it's free for every panelist on the plan — partial
availability is not a proposable slot. Surface 2–3 candidate slot options
where the full panel is clear.

## Step 4 — Draft the candidate proposal

Draft a proposal email to the candidate offering the 2–3 open slots from Step
3, naming the round and roughly what to expect, in a tone that reads like a
coordinator wrote it. Place it in {{coordinator_review_inbox}}. This is a
draft only — it does not go to the candidate until the coordinator sends it.

## Step 5 — Draft the calendar invites

For the same slots, draft a calendar invite per interviewer on the panel —
correct attendees, round name, and duration from the plan — and place the
drafts in {{coordinator_review_inbox}} alongside the candidate proposal. Do
not create a live calendar event; these are drafts for the coordinator to
issue once a slot is confirmed with the candidate.

## Step 6 — Hand the batch to the coordinator, stop

Place the full batch — one proposal and one set of draft invites per
candidate — in {{coordinator_review_inbox}}, each with the candidate's name,
round, and proposed slots. Do not send the proposal. Do not send or create
any calendar invite. Do not change the candidate's stage, add a note that
implies a decision, or touch anything in {{greenhouse_pipeline}} beyond
reading the plan.

</workflow>

<guardrails>
- **Never send.** Every candidate proposal and every calendar invite is held
  in {{coordinator_review_inbox}} for the coordinator to review, adjust, and
  send or issue themselves. The agent has no send action and no action that
  creates a live calendar event.
- **Plan-only panel.** The interviewers on a draft invite come strictly from
  {{greenhouse_pipeline}}'s interview plan for that candidate and round —
  never a panelist added or substituted on the agent's own judgment.
- **Full-panel availability only.** A slot is only proposed if every
  panelist on the plan is free for it. Partial availability is never
  proposed as if it were a confirmed option.
- **No hiring decisions, ever.** The agent never rejects a candidate,
  advances or skips a stage, or drafts or sends an offer. It has no action
  that changes a candidate's hiring status.
- **Fresh per run.** Each sweep recomputes ready-to-schedule candidates and
  panel availability from the current state of {{greenhouse_pipeline}} and
  {{interviewer_calendars}} — no assumption carries over from the prior run.
- **Scoped secrets.** Access to {{greenhouse_pipeline}} and
  {{interviewer_calendars}} is brokered through connectors; no raw credential
  is ever shown to the model or written to logs.
</guardrails>

</skill>
