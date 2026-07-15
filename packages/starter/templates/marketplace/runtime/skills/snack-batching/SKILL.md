---
name: snack-batching
description: Weekly snack-request batching for {{office_channel}}. Collects Slack shortcut submissions since the last order, consolidates duplicates and standing staples, builds a cart against {{preferred_vendor}} within {{weekly_budget}}, and posts it for the office manager to approve before anything is placed.
---

<skill name="snack-batching">

<overview>
Turn scattered snack requests into one approved order a week. A shortcut in
{{office_channel}} is the one place people ask; a weekly cron spawns a fresh
session that reads everything submitted since the last batch, consolidates
it with the standing rules below, prepares a cart against
{{preferred_vendor}}, and posts it for the office manager to approve. Nothing
is placed until that approval lands back in the same channel.

Each run is stateless — there is no ledger. The channel itself is the record:
the last posted draft is the cutoff for "already batched," and an explicit
approval reply is the only thing that authorizes a checkout.
</overview>

<when-to-load>
- The weekly cadence cron fires the batching run.
- Someone replies to a posted draft order in {{office_channel}} — to approve
  it, ask about it, or change a line item.
- A human asks the agent to batch requests early or check the draft status.
</when-to-load>

<workflow>

## Step 1 — Find this week's window

Search {{office_channel}} for the agent's own last "Draft snack order" post.

- Found one → its timestamp is the cutoff; everything after it is unbatched.
- None found (first run) → use the last 7 days as the cutoff.
- Found one that's still awaiting approval → do not start a new batch. Go to
  Step 6 and check whether it's been approved instead.

## Step 2 — Collect requests since the cutoff

Read every message in {{office_channel}} posted by the snack-request shortcut
since the cutoff. Each submission has the shape:

```
New snack request: <item> — qty <n> — requested by <@user>
```

Parse `item`, `qty`, and `requester` out of each one. Discard anything that
isn't a shortcut submission (chatter, threads on old drafts, reactions).

## Step 3 — Consolidate and apply standing rules

- Merge identical or near-identical items (e.g. "Lays", "lays chips", "Lay's
  BBQ chips") into one line, summing quantity and listing every requester.
- Always add the **standing staples** below regardless of whether anyone
  requested them, at their default quantity:
  - Coffee (whole bean) — 2 bags
  - Sparkling water — 2 cases
  - Oat milk — 4 cartons
- These staples, the {{preferred_vendor}} default, and {{weekly_budget}} are
  meant to be edited directly in this file as preferences change — propose
  the edit as a normal change request rather than hardcoding overrides
  elsewhere.

## Step 4 — Build the cart, never check out

Using `ORDERING_ACCOUNT_API_KEY`, search {{preferred_vendor}} for each
consolidated line item and add it to a cart (do not submit/checkout).

- Running total over {{weekly_budget}}? Trim non-staple items with the
  fewest requesters first, cheapest-first among ties, until it fits. Never
  trim a standing staple to make budget.
- Item unavailable? Substitute the closest match from the same vendor and
  flag the substitution in the draft post; if nothing reasonable exists,
  drop the line and flag it instead of guessing.

## Step 5 — Post the draft for approval

Post one message to {{office_channel}}:

```
🧺 Draft snack order — week of <date range>

- <item> × <qty> — requested by <@user, @user2>
- ...
- Coffee (whole bean) × 2 — standing staple
- ...

Total: $<total> (budget: {{weekly_budget}})
Vendor: {{preferred_vendor}}

Nothing has been purchased. Reply "approved" in this thread to place this
order.
```

This is the only output of the run. Stop here — do not poll or wait inside
the session.

## Step 6 — Place the order only after explicit approval

When a reply in-thread on a draft is an explicit approval (e.g. "approved",
"yes, place it", a clear thumbs-up **plus** a written yes from the office
manager) — and only then:

1. Check out the exact cart from Step 4 against {{preferred_vendor}} using
   `ORDERING_ACCOUNT_API_KEY`.
2. Reply in-thread confirming what was placed, the total charged, and the
   expected delivery date if the vendor returns one.

A reply that only asks a question, edits a line item, or reacts without
words is **not** approval — answer or adjust the draft and wait for an
explicit yes. If the thread is still unanswered when the next weekly run
fires, fold its items into the new batch (Step 1) instead of placing it
stale.

</workflow>

<guardrails>
- **No checkout without an explicit, in-thread, written approval.** Silence,
  emoji alone, and side conversation never count.
- **Checkout is the only irreversible step.** Everything before it (search,
  cart-build, draft post) is reversible and safe to redo.
- **Scoped secret.** `ORDERING_ACCOUNT_API_KEY` is injected into the sandbox
  at runtime and is never exposed to the model's output, logs, or the Slack
  post.
- **Isolation.** Each weekly run executes in its own sandbox; only the draft
  post and (post-approval) the checkout call leave it.
- **One draft per week.** Don't post a second draft while one is still
  awaiting approval — resolve or roll it forward first (Step 1).
- **Everything is code.** The vendor, the budget, and the standing staples
  live in this file, versioned and changed only through a reviewed change
  request — never as an ad hoc override during a run.
</guardrails>

</skill>
