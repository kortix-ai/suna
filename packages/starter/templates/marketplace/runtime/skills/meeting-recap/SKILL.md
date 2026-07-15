---
name: meeting-recap
description: The per-meeting runbook for turning a finished call's transcript into structured notes and Linear tickets — the notes format, action-item phrasing, ownership routing from memory, and when to flag instead of guess.
---

<skill name="meeting-recap">

<overview>
Turn one finished meeting into two artifacts: a set of structured notes and a
handful of Linear tickets, one per action item, each assigned to the person who
owns it. The scheduled check spawns a fresh session per meeting the moment it
ends, seeded with the event and its full transcript — this skill is what turns
that raw transcript into the team's standard note format and correctly-routed
tickets, run once per call with no memory of any other meeting.
</overview>

<when-to-load>
- The scheduled check finds a meeting that ended since the last run and has a
  transcript attached.
- A human asks the agent to write up or re-file a specific past meeting.
</when-to-load>

<workflow>

## Step 1 — Read the event and the transcript

Pull the calendar event (title, attendees, agenda) via `google_calendar`. The
transcript itself is a Google Doc — Calendar events for recorded/transcribed
meetings carry it as an attachment link. Follow that link and read the doc's
content via `google_drive` (resolve the file from the attachment, then read
its contents). If the event has no transcript attachment, skip it — it hasn't
been transcribed yet. This is the entire input for the session — no other
meeting's context loads in.

## Step 2 — Load the team's conventions from memory

Read the notes template, the phrasing convention for an action item, and the
ownership map (who owns which area or project) from memory. Skim recent past
meetings on the same topic for continuity — a decision this call revisits
should reference the earlier one, not restate it as new.

## Step 3 — Draft the notes

Write the notes in the standard three-part shape:

| Section | Content |
|---|---|
| Decisions | What was agreed, stated as a fact ("Ship Friday"), not a discussion point |
| Discussion | The context and trade-offs behind each decision, condensed |
| Next steps | Every action item, phrased "[Owner] will [do X] by [when]" |

Attach the notes to the meeting record so they live where the team already
looks for them.

## Step 4 — Resolve an owner for each action item

| Signal | Routing |
|---|---|
| Owner named explicitly in the transcript ("Sarah will handle the migration") | Assign to that person |
| Owner implied by the ownership map (topic maps to a known area owner) | Assign to the mapped owner |
| No explicit owner and no confident map match | Do not guess — flag it (Step 6) |

## Step 5 — File each resolved action item as a Linear ticket

Create one ticket per action item in {{linear_team}}: title is the action
phrased as a task, description is the decision/discussion context plus a link
back to the meeting record, assignee is the owner resolved in Step 4.

## Step 6 — Flag what you can't confidently assign

File any action item without a confident owner as an unassigned ticket in
{{linear_team}}, with the ambiguity spelled out in the description ("raised by
X, no clear owner — needs triage") instead of guessing an assignee.

## Step 7 — Stop once notes and tickets are filed

Once the notes are attached and every action item is either filed-and-assigned
or filed-and-flagged, the session is done. Don't touch any ticket that already
existed before this meeting.

</workflow>

<guardrails>
- **Only create.** The agent never closes, reassigns, or edits a ticket that
  existed before this session — Linear writes are new tickets only.
- **Flag instead of guess.** An action item without a confident owner is filed
  unassigned with the ambiguity noted, never routed to a person on a guess.
- **One meeting, one session.** Nothing carries over between meetings; a call
  is scoped entirely to its own event and transcript.
- **Scoped secrets.** Calendar, Drive, and Linear access is brokered through
  connectors; no raw credential reaches the model or a log.
- **No chat posts.** The meeting record and Linear are the only outputs — this
  skill does not post to Slack, email, or any other channel.
</guardrails>

</skill>
