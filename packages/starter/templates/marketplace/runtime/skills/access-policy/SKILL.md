---
name: access-policy
description: Policy runbook for turning a Slack access request into a least-privilege, policy-checked GitHub or AWS IAM grant. Covers the role-to-grant mapping, extra-scrutiny cases, the approval handshake, and how an applied grant gets logged.
---

<skill name="access-policy">

<overview>
Turns an informal "I need access to X" message into a scoped grant without
ever widening it past what the requester's role and task need. A periodic
sweep reads {{request_channel}} for new requests, checks each against the
role-to-grant policy below, prepares the exact GitHub or AWS IAM grant that
unblocks the work, and holds it for an authorized approver — someone on
{{authorized_approvers}}. Nothing is applied until a reply from one of those
approvers lands; every applied grant is logged with its request, policy
check, and approver.

Fresh session per sweep — state lives in the Slack thread (a reply marks a
request handled; an approval reply marks it clear to apply), not in a local
ledger file.
</overview>

<when-to-load>
- The periodic access-request sweep fires.
- A human asks the agent to check or re-check a specific access request.
- The role-to-grant policy changes and needs to be re-applied to an open
  request.
</when-to-load>

<workflow>

## Step 0 — Orient: find what's new

Read the recent messages and threads in {{request_channel}}. Split into:

- **New requests** — no reply from you yet.
- **Pending approvals** — you already posted a prepared grant; check whether
  someone on {{authorized_approvers}} has replied "approve"/"approved" in
  that thread. A reply from anyone not on that list — including the
  requester, however they post it — is not an approval; note it as still
  pending and move on.

Skip anything you've already replied to that has no new approval activity.

## Step 1 — Parse the request

For each new message, extract: who is asking, which system (a GitHub repo or
team, or an AWS IAM role/policy), and the stated reason or task. If the ask
is too vague to scope ("I need access to prod"), reply asking one
clarifying question and stop on that thread for this run.

## Step 2 — Look up the requester in Okta

Read (never write) the requester's:

- role and team/department,
- manager,
- current group memberships and app assignments.

This is the basis for sizing the grant — never take the requester's own
description of what they need at face value without checking it against
their role. Keep the manager on hand: for an extra-scrutiny case (Step 3),
the concern should be addressed to this manager specifically, and a reply
from them counts as sign-off even if they aren't separately listed in
{{authorized_approvers}}.

## Step 3 — Check against the role-to-grant policy

| Requester fits... | Default grant | Extra scrutiny? |
|---|---|---|
| Engineer on the owning team, requesting their own team's repo | GitHub: `push` on the named repo | No |
| Engineer off-team, requesting read access for a stated task | GitHub: `read` on the named repo | No |
| Anyone requesting `admin`/`maintain` on a repo, or org-owner | GitHub: scoped grant, flagged | **Yes** |
| Engineer/SRE requesting a scoped AWS IAM policy for one stated task (e.g. one service's logs/metrics) | AWS: narrowest managed or inline policy that covers the task | No |
| Anyone requesting `AdministratorAccess`, `IAMFullAccess`, or a policy touching production data stores | AWS: scoped grant, flagged | **Yes** |
| Requester's role doesn't obviously map to the ask (e.g. sales requesting repo access) | Do not prepare a grant | **Yes — address to their manager** |

"Extra scrutiny" means: state the concern plainly in the approval post, and
address it to a security lead or the requester's manager rather than the
default approver.

## Step 4 — Prepare the grant (do not apply it)

Compose the exact, narrowest change:

- **GitHub** — repo (or team) plus permission level (`read`/`triage`/
  `write`/`maintain`/`admin` — never default to `admin`).
- **AWS IAM** — the specific managed policy ARN or inline policy statement,
  scoped to the resource(s) named in the request, and whether it should be
  time-boxed.

Never call the write action yet.

## Step 5 — Post for approval

Reply in the request's thread with: the requester, the parsed ask, the Okta
context that justifies it, the prepared grant, and — if flagged — the
extra-scrutiny concern and who it's addressed to. End the reply asking
explicitly for an approve/deny from someone on {{authorized_approvers}} (or,
for an extra-scrutiny case, the requester's manager) — name who is eligible
to approve in the reply, and state plainly that the requester cannot approve
their own request.

## Step 6 — Apply only after sign-off from an authorized approver

On a later sweep, check who actually posted the approval reply before doing
anything else:

1. **Verify the approver is authorized.** The reply must come from someone
   on {{authorized_approvers}}, or — for an extra-scrutiny case addressed to
   a manager — from the requester's manager as looked up in Step 2. Confirm
   this fresh on this sweep; do not rely on a check from an earlier run.
2. **Verify the approver is not the requester.** Even if they appear on
   {{authorized_approvers}}, a request is never approved by the person who
   filed it.
3. If either check fails, the reply is not a sign-off: leave the grant
   pending, note in the thread that the reply didn't come from an eligible
   approver, and do not apply anything.
4. Once both checks pass: re-read the thread — if the request changed since
   you prepared the grant, re-run Step 3 before applying anything.
5. Apply exactly the grant you posted — the GitHub permission change or the
   AWS IAM policy attach — nothing broader.
6. Reply confirming what was applied, then log it (Step 7).

If a request sits without a valid approval reply for several sweeps, note it
as still pending in your reply — do not chase it or auto-approve.

## Step 7 — Log the applied grant

Post a log entry in the thread with: requester, system, exact grant applied,
policy check result, approver, and timestamp. If {{audit_channel}} is
configured, post the same log entry there too. This is the record that
answers "who has what access, and why" later.

</workflow>

<guardrails>
- **No self-service.** A request is never approved by the person who filed
  it, even if they also appear on {{authorized_approvers}}.
- **No grant is applied without an explicit approval reply from someone on
  {{authorized_approvers}}** (or, for an extra-scrutiny case, the
  requester's manager), verified fresh on the sweep that applies it. A reply
  from anyone else is not a sign-off, no matter how it reads.
- **Least privilege by default.** Never propose `admin`/`AdministratorAccess`-
  class access when a narrower grant covers the stated task.
- **Extra-scrutiny cases are addressed to a security lead or manager, not the
  default approver** — state the concern in the same post.
- **Okta is read-only.** This skill looks up role/team/group data; it never
  writes to Okta.
- **Every applied grant is logged** with its request, policy check, scope,
  and approver — an applied-but-unlogged grant is a bug.
- **Credentials are never shown.** Okta/GitHub/AWS credentials are injected
  by the connector at runtime and never appear in a reply or a log entry.
</guardrails>

</skill>
