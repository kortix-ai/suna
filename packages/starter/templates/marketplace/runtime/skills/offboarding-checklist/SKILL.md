---
name: offboarding-checklist
description: Employee offboarding runbook for {{projectName}}. Detects newly marked departures via the {{hris_group}} group in Okta, then works one scoped case per departure across Okta, Google Workspace, and GitHub — revoking access, transferring ownership, and reclaiming licenses — holding irreversible steps for a human approval gate and posting the completed checklist to {{notify_channel}}.
---

<skill name="offboarding-checklist">

<overview>
Run the full offboarding checklist for each employee departure, in the right
order, without skipping the steps that are easy to forget under time pressure.
Each run is a fresh session — one departure maps to one scoped case on one
disposable sandbox, and nothing carries over between runs. Reversible steps
(revoking access, reclaiming licenses) run immediately; irreversible steps
(deleting an account, transferring ownership away from a person) wait for a
human.
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
  step touches state from a previous run — this session doesn't have one.

If nobody new is marked, end the turn; there is nothing to run.

## Step 1 — Open the case

For the departing person, record: full name, email, Okta user ID, GitHub
username (if known), and manager. This is the scope of everything that
follows — don't touch access for anyone else.

## Step 2 — Okta: revoke SSO and app access

- Deactivate the person's Okta account. This is reversible — a deactivated user
  can be reactivated; deleting is not, and deletion is never done here.
- Pull the app assignments hanging off the account and remove them, so
  downstream SSO-brokered access (including Slack, where it's SSO-connected)
  drops with it.
- Record which apps were deprovisioned in the checklist.

## Step 3 — Google Workspace: transfer ownership, then suspend

- List the documents and shared drives the person owns.
- Reassign ownership to their manager (or the team lead named in the case) so
  nothing is orphaned. **This is irreversible — hold it at the approval gate
  (Step 5) before executing**, and note the intended new owner in the checklist
  so the approver can confirm it's right.
- Once the ownership transfer is approved and done, suspend the Google
  Workspace account (reversible) and release its license back to the pool.

## Step 4 — GitHub: remove org and team access

- Remove the person from the GitHub org and every team they're a member of.
- If they're the sole owner of a repository or the last admin on a team, flag
  it instead of removing them outright — that needs a human to name a new
  owner first.
- Reclaim any paid GitHub seat.

## Step 5 — Approval gate for irreversible steps

Before anything irreversible executes — account deletion, ownership transfer
away from a person — stop and surface it as a pending approval in the
checklist: what it is, why it's needed, and what it will do. Only proceed once
a human approves. Never delete an account in this workflow; deactivation/
suspension is the terminal reversible state.

## Step 6 — Reclaim remaining licenses

Sweep the connected systems for any other paid seat tied to the person beyond
Google Workspace and GitHub, and release it.

## Step 7 — Post the completed checklist

Post to `{{notify_channel}}`: every step taken (system, action, result), every
item still waiting on human approval with why, and anything that failed with
the error. Never report a step as done unless it actually completed — a
pending approval is listed as pending, not as done.

</workflow>

<guardrails>
- **Human approval gate for irreversible steps.** Account deletion and
  ownership transfer away from a person always stop for a human. No
  exceptions, no "obviously fine" fast path.
- **Scoped, brokered credentials.** Okta, Google Workspace, and GitHub access
  is injected into the sandbox at runtime and never exposed to the model or
  written to logs.
- **One case per departure, no cross-run memory.** Each run is independent —
  don't infer anything about today's departure from a previous session's state
  beyond what's recorded on the person's own profile/notes.
- **Isolation.** Every departure runs in its own sandbox; only the checklist
  result leaves it.
- **Never delete, only deactivate/suspend.** Deletion of an account is out of
  scope for this agent entirely.
</guardrails>

</skill>
