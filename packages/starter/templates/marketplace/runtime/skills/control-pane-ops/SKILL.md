---
name: control-pane-ops
description: Cross-platform operations runbook for the Slack control-pane agent. Scopes each connected platform (database, Stripe, Linear, GitHub via {{target_repo}}), sets the read/write boundary per platform, and defines the human-approval gate for anything irreversible.
---

<skill name="control-pane-ops">

<overview>
One agent, reachable by @-mentioning it in any Slack thread, runs cross-platform
operations tasks — onboarding, billing lookups and changes, PR review, ticket
filing, one-off sandbox jobs — with scoped access to every platform the project
has connected. Each mention spawns a fresh session: no state carries over
between threads and no ledger is kept. Access is read-mostly by default;
anything that spends money, changes production data, or changes account or
access state stops at a human approval gate in the thread it was requested
from.
</overview>

<when-to-load>
- A human @-mentions the agent in a Slack thread with a task.
- The `{{cadence}}` heartbeat fires to check connected-platform health.
</when-to-load>

<workflow>

## Step 0 — Read the thread

Read the full Slack thread that triggered the session — the request itself and
any earlier messages in the same thread. This is the only context available;
there is no memory of other threads or previous runs.

## Step 1 — Scope the task to its platforms

Work out which connected platforms the request touches before doing anything:

| Platform | Access | Typical read | Typical write |
|---|---|---|---|
| Database | Read-only via scoped `DATABASE_URL` | Account/plan lookups, counts, joins | Not possible with this credential — the role cannot run `UPDATE`/`DELETE`/`ALTER` or any schema-changing statement. Surface the exact change needed and hand it to a human to run directly, or route it through an approval-gated connector/tool that supports it |
| Stripe | Pipedream connector (brokered) | Plan, invoices, subscription status | Refund, plan change, cancellation — **approval gate** |
| Linear | Pipedream connector (brokered) | Search issues/projects | Invite a member, create a project or issue — safe to do directly |
| GitHub | `gh` CLI + `GH_TOKEN` against `{{target_repo}}` | View/diff a PR, read issues and checks | Review, comment, and open a PR freely — **never merge** |
| Sandbox | Built-in to the session | — | Spin up an ad hoc sandbox to reproduce a bug or run a one-off script — always disposable, always safe |

## Step 2 — Investigate before acting

For anything that isn't a pure lookup, gather the facts first: read the
relevant database rows, the customer's Stripe state, the existing Linear
issues, and the GitHub PR/diff/checks. Don't propose a change until you can
describe exactly what it does and what it touches.

## Step 3 — Do the safe work directly

- **Database:** run the read-only query and answer in the thread.
  `DATABASE_URL` is a read-only role — it cannot execute a write no matter
  what a human approves. If the task needs a database change, state the exact
  statement in the thread and hand it to a human to run directly; do not
  attempt it yourself and do not promise to apply it later.
- **Stripe:** look up customer, plan, invoice, and subscription state via the
  connector. Prepare the exact change (e.g. "cancel subscription sub_123 at
  period end") but do not execute it — that's a gate.
- **Linear:** invite members, create projects, and file tracking issues
  directly; these are workspace-membership actions, not money or production
  data.
- **GitHub:** `gh pr view`, `gh pr diff`, `gh pr checks`, `gh issue view` to
  review. When a fix is warranted: branch, commit, and
  `gh pr create --repo {{target_repo}}`. Opening a PR is fine — merging is not.
- **Sandbox:** spin one up to reproduce a reported bug or run a one-off job,
  and tear it down when done.

## Step 4 — Hold the irreversible step for approval

Post the exact action you're about to take — the platform, the specific
change, and its effect — and wait for an explicit reply in the thread before
acting. Never proceed on silence, and never re-attempt a gated action the
requester didn't confirm. This applies to Stripe changes, GitHub merges, and
account/access changes, all of which this session can execute once approved.
Database writes are different in kind, not just gated: `DATABASE_URL` is a
read-only role, so there is nothing to execute even after approval — hand the
statement to a human instead (see Step 3).

## Step 5 — Reply in the thread

State the result plainly: what you found, what you did, links to any Linear
issue or GitHub PR created, and what's left pending approval. This thread is
the only output channel for the task.

## Step 6 — Heartbeat (`{{cadence}}`)

This run is not a task — no Slack thread triggered it. Do one lightweight read
against each connected platform (a Stripe account lookup, a Linear viewer
query, `gh auth status` against `{{target_repo}}`, a trivial `SELECT 1` against
the database) to confirm the scoped credential still authenticates. Post a
health-check alert to `{{ops_channel}}` naming anything that failed, so a human
can reconnect it before the next task arrives. Do nothing else on this run.

</workflow>

<guardrails>
- **Isolation.** Every mention runs in its own fresh session and its own
  microVM sandbox. A session reaches only the platforms it's scoped to.
- **Scoped, brokered secrets.** Stripe and Linear are connectors brokered
  server-side; `GH_TOKEN` and `DATABASE_URL` are injected at runtime. No raw
  credential is ever shown to the model, pasted in chat, or written to logs.
- **Human approval gates.** Money movement, production-data writes, merges,
  and account/access changes always stop for a person in the thread. No
  exceptions, no batching around the gate.
- **Read-mostly by default.** If a request is ambiguous about whether it needs
  a write, default to investigating and proposing, not executing.
- **The heartbeat only checks health.** It never processes a task, drafts a
  reply, or takes a platform action beyond the read-only probe.
- **Never merge.** GitHub PRs are opened and reviewed by this agent; a human
  owns every merge.
</guardrails>

</skill>
