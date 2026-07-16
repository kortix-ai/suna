---
name: offboarding-checklist
description: Employee offboarding runbook for {{projectName}}. Detects newly marked departures via the {{hris_group}} group in Okta, then works one independent case per departure across Okta, Google Workspace, Google Drive, and GitHub — revoking access, transferring ownership, and reclaiming licenses — holding the ownership transfer for a human approval gate (never deleting an account) and posting the completed checklist to {{notify_channel}}.
---

<skill name="offboarding-checklist">

<overview>
Run the full offboarding checklist for each employee departure, in the right
order, without skipping the steps that are easy to forget under time pressure.
Each run is a fresh session on a schedule, and a single run can find more than
one new departure — handle each one as its own independent case, and a
failure or a pending approval on one case must never block the others.
Nothing carries over between runs. Reversible steps (revoking access,
reclaiming licenses) run immediately; transferring ownership away from a
person is irreversible and waits for a human. Account deletion is never
performed by this agent — it is out of scope entirely.
</overview>

<when-to-load>
- The scheduled check fires and needs to look for new departures.
- A human asks the agent to offboard a specific person out of band.
- A prior offboarding case has items still pending a human approval and needs a
  status check.
</when-to-load>

<workflow>

## Step 0 — Detect the departure

Check the `{{hris_group}}` group (or equivalent departure flag) in Okta for
anyone newly added since the last check:

- Pull current membership of `{{hris_group}}`.
- Diff against who was already processed — look on the person's Okta profile
  for a prior `offboarding: complete` or `offboarding: pending-approval` note
  left by an earlier run.
- Treat each newly marked person as one independent case. Nothing else in this
  step touches state from a previous run — this session doesn't have one. A
  failure or a pending approval on one case must never block working the
  others found in the same run.

If nobody new is marked, end the turn; there is nothing to run.

## Step 1 — Open the case

For the departing person, record: full name, email, Okta user ID, GitHub
username (if known), and the manager's Google Workspace email — the intended
new owner for the document and shared-drive ownership transfer in Step 3.
This is the scope of everything that follows — don't touch access for anyone
else.

## Step 2 — Okta: revoke SSO and app access

- Deactivate the person's Okta account. This is reversible — a deactivated user
  can be reactivated. Account deletion is never performed here or anywhere in
  this workflow.
- Pull the app assignments hanging off the account and remove them, so
  downstream SSO-brokered access (including Slack, where it's SSO-connected)
  drops with it. Release any per-user paid license tied to those app
  assignments.
- Record which apps were deprovisioned in the checklist.

## Step 3 — Google Drive and Workspace: transfer ownership, then suspend

- Using Google Drive, list the documents and shared drives the person owns.
- Reassign ownership to the manager's Workspace email recorded in Step 1 so
  nothing is orphaned. **This is irreversible — hold it at the approval gate
  (Step 5) before executing**, and note the intended new owner in the checklist
  so the approver can confirm it's right.
- Once the ownership transfer is approved and done, suspend the person's
  Google Workspace account via the admin console (reversible) and release its
  license back to the pool.

## Step 4 — GitHub: remove org and team access

- Remove the person from the GitHub org and every team they're a member of.
- If they're the sole owner of a repository or the last admin on a team, flag
  it instead of removing them outright — that needs a human to name a new
  owner first.
- Reclaim any paid GitHub seat.

## Step 5 — Approval gate for the ownership transfer

Before the ownership transfer in Step 3 executes, stop and surface it as a
pending approval in the checklist: what it is, why it's needed, and the
intended new owner. Only proceed with the transfer once a human approves.
Account deletion is never attempted by this agent — deactivation/suspension is
the terminal state it can reach; if an account genuinely needs to be deleted,
that decision and action belong to a human outside this workflow.

## Step 6 — Post the completed checklist

Post to `{{notify_channel}}`: every step taken (system, action, result), every
item still waiting on human approval with why, and anything that failed with
the error. Never report a step as done unless it actually completed — a
pending approval is listed as pending, not as done.

</workflow>

<guardrails>
- **Human approval gate for ownership transfer.** Reassigning document or
  shared-drive ownership away from a person always stops for a human. No
  exceptions, no "obviously fine" fast path.
- **Never delete, only deactivate/suspend.** Account deletion is out of scope
  for this agent entirely — it is never performed, approval-gated or
  otherwise. Deactivation/suspension is the terminal state the agent can
  reach; an actual deletion is a human decision made outside this workflow.
- **Scoped, brokered credentials.** Okta, Google Workspace, Google Drive, and
  GitHub access is injected into the sandbox at runtime and never exposed to
  the model or written to logs.
- **Independent cases, no cross-run memory.** Each run is independent and can
  contain more than one departure — don't infer anything about today's
  departures from a previous session's state beyond what's recorded on each
  person's own profile/notes, and never let one case's failure or pending
  approval block another.
- **Isolation.** Every departure case runs inside the same scoped sandbox for
  that run; only the checklist result leaves it.
</guardrails>

</skill>
