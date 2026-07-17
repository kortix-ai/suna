---
name: outbound-sourcing
description: Daily outbound-sourcing sweep for {{greenhouse_role}}. Searches LinkedIn for candidates matching {{sourcing_criteria}}, dedupes every match against the role's Greenhouse pipeline, and drafts a personalized outreach email per new candidate to {{recruiter_review_inbox}} — capped at {{daily_cap}} per run. Never sends outreach and never writes to Greenhouse; the recruiter reviews, sends, and owns the ATS.
---

<skill name="outbound-sourcing">

<overview>
Outbound recruiting is a research problem before it's a writing problem: find
people who genuinely match the role, don't re-surface anyone already in the
pipeline, and write to their actual background instead of a template. A daily
sweep does both — it searches LinkedIn against the role's written sourcing
profile, checks {{greenhouse_role}}'s Greenhouse pipeline before drafting
anything, and produces one personalized outreach email per new candidate for
the recruiter to review.

This is **outbound** sourcing — distinct from screening inbound applicants.
There is no application to score here; the agent is proactively finding
people who haven't applied and proposing a first contact. Fresh session every
run, no local ledger: the agent recomputes the batch from LinkedIn and
Greenhouse each time, so what "already handled" means is whatever the
Greenhouse pipeline already shows for this role.
</overview>

<when-to-load>
- The daily sourcing cron fires for {{greenhouse_role}}.
- A human asks the agent to source candidates for a specific open role.
- The sourcing profile ({{sourcing_criteria}}) or the outreach angles in
  memory change and need to be reflected in the next run.
</when-to-load>

<workflow>

## Step 1 — Read the role's current pipeline

Before searching for anyone new, pull the full current state of
{{greenhouse_role}}'s Greenhouse pipeline: every candidate already applied,
already sourced and contacted by a person, and already rejected or passed on
at any stage. This is the dedupe list for the rest of the run — build it
first, use it in every later step.

## Step 2 — Search LinkedIn against the sourcing profile

Search LinkedIn for candidates matching {{sourcing_criteria}} — title,
seniority, skills, and any other criteria the profile specifies. Pull enough
of each result's real background (current and past roles, tenure, skills,
notable work) to both dedupe and draft against later. Don't stop at the
first page of results; keep sourcing until you have enough plausible matches
to fill the run, capped at {{daily_cap}}.

## Step 3 — Dedupe against the pipeline

For every LinkedIn match, check it against the Step 1 pipeline by name and,
where available, by email or LinkedIn URL. Drop anyone who is:

- Already an applicant in {{greenhouse_role}}'s pipeline.
- Already contacted by a person for this role (a sourced/contacted stage or
  note in Greenhouse).
- Already rejected or passed on for this role at any stage.

Only candidates who clear all three are new — carry those into Step 4.

## Step 4 — Draft personalized outreach

For each new candidate, up to {{daily_cap}} this run, draft a first-touch
outreach email that:

- References one or two specific, real details from their background — their
  actual current role, a notable project, a skill or transition that fits
  {{greenhouse_role}} — not a generic opener.
- States plainly what the role is and why their background prompted the
  outreach.
- Uses the tone and proof points from memory: what's worked in prior
  outreach for this kind of role, and what to avoid.

If a draft would read the same with the candidate's specifics removed, it
isn't personalized enough — go back to their background and find the real
detail to write to.

## Step 5 — Hand the batch to the recruiter, stop

Place the full batch of drafted candidates in {{recruiter_review_inbox}}:
each draft alongside the candidate's name, current role, LinkedIn profile,
and the reason they matched. Do not send anything. Do not create, update, or
tag any record in Greenhouse — the recruiter decides whether and when to add
a candidate to the ATS, and whether and when to send.

</workflow>

<guardrails>
- **Never send.** Every drafted email is held in {{recruiter_review_inbox}}
  for the recruiter to review, edit, and send themselves. The agent has no
  send action.
- **Never write to Greenhouse.** The agent reads the pipeline to dedupe; it
  never creates, updates, moves, or tags a candidate record. Adding a sourced
  candidate to the ATS is the recruiter's decision.
- **Dedupe is mandatory before drafting.** No candidate gets a draft before
  their name has been checked against the current Greenhouse pipeline for
  {{greenhouse_role}}. Skipping this step is how duplicate outreach happens.
- **Daily cap.** Source and draft at most {{daily_cap}} new candidates per
  run, regardless of how many LinkedIn results match, so a batch always stays
  a size the recruiter can actually review.
- **Grounded personalization only.** Every draft traces to specific, real
  details from that candidate's LinkedIn background — no template with a
  name substituted in.
- **Scoped secrets.** Greenhouse and LinkedIn access is brokered through
  connectors; no raw credential is ever shown to the model or written to
  logs.
</guardrails>

</skill>
