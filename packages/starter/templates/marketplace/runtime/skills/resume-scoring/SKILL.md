---
name: resume-scoring
description: Scores an inbound application against the role's written rubric with supporting quotes as evidence, writes a structured screen back to {{applications_source}}, and proposes interview slots on {{hiring_manager_calendar}} for strong matches. Never advances or rejects a candidate — every decision stays with the hiring manager.
---

<skill name="resume-scoring">

<overview>
Give every inbound application the same first read: score it against the
role's actual written rubric, back every judgment with a quote from the
resume itself, and — only for strong matches — put candidate interview times
on the hiring manager's calendar for them to confirm. Each application is its
own self-contained pass with no memory of the candidates before it, so the
bar never drifts run to run. The agent never decides who advances; it hands
the hiring manager a checkable screen.
</overview>

<when-to-load>
- The scheduled sweep fires and finds an application in
  {{applications_source}} that hasn't been screened yet.
- A human asks for a fresh screen on a specific candidate, or asks why a
  candidate scored the way they did.
</when-to-load>

<workflow>

## Step 1 — Load the rubric

Read {{role_rubric}} in full before looking at any application: the required
criteria, the preferred criteria, what strong evidence looks like for each,
and how they're weighed into an overall score. This is the only standard you
score against — not general resume-reading judgment.

## Step 2 — Find the next unscreened application

Check {{applications_source}} for applications that don't already carry a
screen (no screen note, no "screened" tag/status). Pick one and treat it as a
fully independent pass — nothing from another candidate's screen carries
over, and nothing here should carry into the next one.

## Step 3 — Read the full application

Read the entire resume and any attached materials for that one candidate —
not a skim. Note concrete, quotable claims (roles, scope, outcomes, tools)
you'll need for evidence in Step 4.

## Step 4 — Score against the rubric

For every rubric criterion:

| Judgment | Meaning |
|---|---|
| Met | Clear evidence in the resume that the criterion is satisfied |
| Partially met | Related but incomplete or ambiguous evidence |
| Not met | No evidence, or evidence contradicts the criterion |

For each criterion, pull the exact quote from the resume that supports the
judgment — no judgment without a quote. Roll the per-criterion judgments up
into one overall score per the rubric's weighting, and separate required
criteria (a "not met" here caps the overall score) from preferred ones (a
tiebreaker, not a gate).

## Step 5 — Write the structured screen

Write back to {{applications_source}} a screen containing: overall score,
**strengths** (criteria met, with quotes), **gaps** (criteria not/partially
met, with quotes or the absence noted), and the rubric weighting used. This
is the artifact the hiring manager reviews — it must stand on its own
without you in the room.

## Step 6 — Propose interview slots for strong matches only

If the overall score clears the rubric's "strong match" bar, check
{{hiring_manager_calendar}} for open slots in the next few business days and
propose 2–3 candidate times as **tentative, unconfirmed holds** — never a
sent invite, never a booked event. Below the bar, write the screen and stop;
no slots are proposed.

## Step 7 — Mark the application screened

Tag or annotate the application in {{applications_source}} as screened so the
next sweep skips it. This is what makes the sweep idempotent across runs with
no shared memory.

</workflow>

<guardrails>
- **Never auto-reject or auto-advance.** The agent has no "reject" or
  "advance" action. It writes a screen and, for strong matches, proposes
  slots — the hiring manager makes every decision.
- **Rubric-only scoring.** Score strictly against {{role_rubric}}. When the
  rubric changes, screen against the new version — never fall back to
  general judgment when the rubric is silent on something.
- **Evidence or it didn't happen.** Every strength, gap, and score traces to
  a quote from the actual application. No unsupported judgments.
- **Isolation per candidate.** Each application is its own independent pass,
  seeded with just that resume and the rubric. Only the screen and any
  proposed slots leave the sandbox.
- **Proposed, never confirmed.** Interview slots are tentative holds on
  {{hiring_manager_calendar}}, offered for a person to confirm — the agent
  never sends the invite.
- **Scoped secrets.** Access to {{applications_source}} and
  {{hiring_manager_calendar}} is brokered through connectors; no raw
  credential is ever shown to the model or written to logs.
</guardrails>

</skill>
