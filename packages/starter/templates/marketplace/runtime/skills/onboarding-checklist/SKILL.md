---
name: onboarding-checklist
description: New-hire onboarding runbook for {{projectName}}. Detects new-hire records via the {{new_hire_group}} group in Google Workspace, then works one scoped case per hire — preparing the Workspace account and group memberships, adding them to the right Slack channels, and filing a first-week checklist in the {{onboarding_project}} Linear project — holding account creation and group membership for a human approval gate and posting the result to {{notify_channel}}.
---

<skill name="onboarding-checklist">

<overview>
Prepare the accounts, memberships, and first-week checklist a new hire needs
well before their first day, without missing a step under time pressure. Each
run is a fresh session — one new-hire record maps to one scoped case on one
disposable sandbox, and nothing carries over between runs. A single check can
surface more than one new hire; handle each as an independent unit — a failure
on one never blocks or delays onboarding for the others found in the same
check. Steps that only set up work in flight — Slack channel invites, the
Linear checklist — run directly; steps that grant systems access — Workspace
account creation, group membership — wait for a human.

Which groups a role belongs to, which channels a team joins, and what a good
first week looks like is the **onboarding standard**: a standing reference at
`.kortix/memory/onboarding-standard.md`, read fresh every run. It isn't a
run-to-run ledger — it's policy, and it only changes when a human edits it.
</overview>

<when-to-load>
- The scheduled check fires and needs to look for new-hire records.
- A human asks the agent to onboard a specific person out of band.
- A prior onboarding case has items still pending a human approval and needs a
  status check.
</when-to-load>

<workflow>

## Step 0 — Detect the new hire

Check the `{{new_hire_group}}` group in Google Workspace for anyone newly
added since the last check:

- Pull current membership of `{{new_hire_group}}`.
- Diff against who was already processed — look for a prior `onboarding:
  complete` or `onboarding: pending-approval` note left by an earlier run
  (on the record itself, or in the case's Linear checklist if one already
  exists).
- Treat each newly marked person as one independent case. Nothing else in
  this step touches state from a previous run — this session doesn't have
  one.

If nobody new is marked, end the turn; there is nothing to run.

## Step 1 — Open the case

For the new hire, record: full name, personal or work-provided email, role,
team, manager, and start date. This is the scope of everything that
follows — don't touch access or membership for anyone else.

## Step 2 — Read the onboarding standard

Read `.kortix/memory/onboarding-standard.md` for this role and team:

- the Google Workspace groups and aliases the role belongs to,
- the Slack channels the team works in,
- the first-week checklist template for the role.

If the role or team isn't covered, use the closest documented match, note the
gap in the checklist, and flag it for a human to add to the standard.

## Step 3 — Google Workspace: prepare the account and memberships

- Compose the plan: mailbox address, aliases, and the group memberships the
  role calls for, per the onboarding standard.
- **This is the step that grants access — hold it at the approval gate
  (Step 6) before creating anything.** Note the planned mailbox, aliases, and
  groups in the checklist so the approver can confirm them.
- Do not create the account or add any group membership until it clears the
  gate.

## Step 4 — Slack: add the hire to the team's channels

- Invite the new hire to the Slack channels their team works in, per the
  onboarding standard.
- This runs directly — channel membership doesn't grant systems access, so it
  isn't held for approval.
- Record which channels were added in the checklist.

## Step 5 — Linear: file the first-week checklist

- Create a first-week onboarding issue (or set of issues) in the
  `{{onboarding_project}}` Linear project, populated from the role's checklist
  template in the onboarding standard.
- This also runs directly, in parallel with Step 4.

## Step 6 — Approval gate for account creation and group membership

Before the Workspace account is created or any group membership is applied,
stop and surface it as a pending approval in the checklist: the planned
mailbox, aliases, and groups, and why they were chosen. Only proceed once a
human approves. On a later run, check whether that approval has landed; if it
has, create the account and apply the memberships exactly as planned — if the
role or team changed since the plan was made, re-run Step 2 before applying
anything.

## Step 7 — Post the result

Post to `{{notify_channel}}`: what's prepared and done (Slack channels,
Linear checklist), what's still waiting on human approval (account,
memberships) with why, and anything that failed with the error. Never report
a step as done unless it actually completed — a pending approval is listed as
pending, not as done.

</workflow>

<guardrails>
- **Human approval gate for account creation and group membership.** Both
  always stop for a human. No exceptions, no "obviously fine" fast path.
- **Slack channel invites and the Linear checklist are not gated.** They don't
  grant systems access, so they proceed directly — but they're still reported
  in the same result post.
- **Scoped, brokered credentials.** Google Workspace and Linear access is
  injected into the sandbox at runtime and never exposed to the model or
  written to logs.
- **One case per new hire, no cross-run memory beyond the standard.** Each run
  is independent — don't infer anything about today's new hire from a previous
  session's state beyond what's recorded on the person's own case, and never
  treat `.kortix/memory/onboarding-standard.md` as anything but standing
  policy. When a check finds several new hires at once, never let one case's
  failure or pending approval block another.
- **Isolation.** Every new hire runs in its own sandbox; only the checklist
  result leaves it.
- **Never create an account or add a group membership without a recorded
  approval.** If approval hasn't landed, the case stays pending — it does not
  time out into an automatic yes.
</guardrails>

</skill>
