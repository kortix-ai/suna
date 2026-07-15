---
name: call-recap
description: The per-call runbook for turning a finished sales call's transcript — found in the connected Google Drive folder — into an updated HubSpot deal (or a flagged handoff when no deal matches), filed follow-up tasks in {{linear_team}}, and a drafted recap email — held for the rep's approval before it sends.
---

<skill name="call-recap">

<overview>
Turn one finished sales call into three artifacts: an updated HubSpot deal, a
handful of Linear tasks — one per commitment made on the call — and a drafted
recap email ready for the rep. The scheduled check spawns a fresh session per
new transcript file it finds in the connected Google Drive folder, seeded with
that one call — this skill is what turns the raw transcript into the
account's next CRM state, its follow-up tasks, and a recap the rep can send
with a read, not a rewrite.
</overview>

<when-to-load>
- The scheduled check finds a new transcript in the connected Google Drive
  folder since the last run.
- A human asks the agent to write up or redraft the recap for a specific past
  call.
</when-to-load>

<workflow>

## Step 1 — Find and read the transcript

The call recorder drops the transcript into the connected Google Drive folder
({{transcript_folder}}) once a call finishes. Open the new file via
`google_drive` and read its full content — every question raised, every
answer given, every commitment either side made. This is the entire input for
the session; no other call's context loads in.

## Step 2 — Match the call to its HubSpot deal

Identify the deal from the call's attendees (contact email domain, company
name).

| Signal | Routing |
|---|---|
| Exactly one deal matches confidently | Pull its current stage, notes, and contact list before writing anything, so Step 4's update is a diff against reality, not a guess |
| No deal matches, or more than one plausibly matches | Do not guess — skip Step 4 and flag the call instead when you hold it for approval (Step 7), so a human links it to the right deal manually |

## Step 3 — Load the account's history and the recap playbook from memory

Read the shape of a good recap, how the team phrases next steps, which kinds
of objections need a considered answer, and this account's own history (past
calls, open threads) from memory. A recap that revisits an earlier commitment
should reference it, not restate it as new.

## Step 4 — Update the HubSpot deal

Skip this step entirely if Step 2 didn't produce a confident deal match — go
straight to Step 5, and let Step 7 carry the flag instead. Otherwise write
back what the call actually covered:

| Field | Update |
|---|---|
| Stage | Advance only if the call clearly moved the deal (verbal commit, next step scheduled) — otherwise leave it |
| Notes | Append a summary of the call: what was discussed, decided, and asked |
| Contacts | Add any new attendee who isn't already on the deal |

## Step 5 — File the follow-up tasks

Create one Linear task per commitment in {{linear_team}}: title is the
commitment phrased as a task, description is the context plus a link back to
the call, due date from anything the call implied ("by Friday"), assignee is
the rep who hosted the call (the owner/host field on the transcript file or
recording). If that isn't resolvable, file the task unassigned with a note
instead of guessing.

## Step 6 — Draft the recap email

Write the recap to the account's history and the team's playbook: a short
summary of the call, a direct answer to every open question that came up, and
the next steps restated plainly. Ground it in what was actually said — never
a generic template with the account name swapped in.

## Step 7 — Hold for approval

Place the drafted recap in {{approval_channel}} as a draft only. Do not send
it. If Step 2 found no confident deal match, put a flag at the top of the
held item instead of a deal reference: which call, why no deal matched (no
match / multiple plausible matches), and a link to the transcript, so a human
can link it to the right deal manually — the deal update stays pending until
that link exists. Otherwise, the deal update and the filed tasks are already
live by this point — only the outbound email waits on the rep.

</workflow>

<guardrails>
- **Never send.** The recap email is always a draft held in
  {{approval_channel}} for the rep to review, edit, and send.
- **One call, one session.** Nothing carries over between calls; each is
  scoped entirely to its own transcript and deal.
- **Flag instead of guess.** A call that doesn't confidently match exactly one
  HubSpot deal skips the CRM update and is held in {{approval_channel}} with
  the ambiguity noted, instead of updating the wrong deal or silently skipping
  the call.
- **CRM writes are grounded in the transcript.** Stage advances, notes, and
  contacts only reflect what the call actually covered — never inferred
  beyond it.
- **Scoped secrets.** Google Drive, HubSpot, and Linear credentials are
  injected by the connector at runtime and never exposed to the model or
  written to logs.
- **No chat posts.** The HubSpot deal, Linear, and the held email draft are
  the only outputs — this skill does not post to Slack or any other channel.
</guardrails>

</skill>
