---
name: kb-gap-mining
description: Weekly reusable-session ticket-to-KB loop. Reads recently resolved Plain threads, clusters them into recurring topics, cross-references {{kb_path}} of {{kb_repo}} and a durable ledger to find topics with real volume and no article, drafts the top gaps from the actual resolutions, and opens a PR only — never publishing or merging.
---

<skill name="kb-gap-mining">

<overview>
Turn resolved Plain support tickets into knowledge-base coverage without
duplicating what already exists. A weekly cron re-prompts a persistent
session, pulls recently resolved threads, clusters them into recurring
topics, and checks each topic against the KB repo's existing articles and the
session's own ledger of topics already drafted or covered. Topics that clear
both bars — recurring enough to matter, and genuinely undocumented — get
drafted from the real resolutions used in their tickets. Each run opens one
PR. The agent never publishes and never merges.

Proactive and schedule-driven; the ledger is what keeps runs from redrafting
the same gap or duplicating a PR still under review.
</overview>

<when-to-load>
- The weekly cron fires the ticket-to-KB sweep.
- A human asks the agent to check for KB gaps or run a mining pass.
- A prior run's PR needs a follow-up before the next batch starts.
</when-to-load>

<workflow>

## Step 0 — Orient and resume

```sh
# Read the durable ledger first — covered topics, drafted-but-unmerged
# topics, and clusters seen before that didn't clear the bar.
cat .kortix/memory/kb-gap-mining-log.md 2>/dev/null || echo "(no ledger yet)"

# Check any open KB-gap PR from a prior run.
gh pr list --repo {{kb_repo}} --state open \
  --search 'in:title "kb: draft" OR label:kb-gap' \
  --json number,title,headRefName,statusCheckRollup,url
```

If a prior PR is still open and unreviewed, note its topics and don't
duplicate them in this run's batch.

## Step 1 — Pull recently resolved tickets from Plain (read-only)

Using `PLAIN_API_KEY`, pull threads resolved since the ledger's last-run
timestamp (or the trailing 7 days if this is the first run). For each
resolved thread, extract:

- The question or problem as the customer originally stated it.
- The resolution actually used to close it — the steps, the answer, the
  workaround — in the agent's or teammate's own words.
- Enough context (thread ID) to trace the draft back to its source tickets,
  without carrying customer names or account details forward.

Skip threads with no reusable resolution (spam, duplicate of an in-progress
bug, "never replied").

## Step 2 — Cluster into topics

Group extracted tickets into topics using intent, not wording — "can't reset
my password" and "reset link never arrives" are the same topic if the
underlying question and resolution are the same; a superficially similar
phrase with a different root cause is a different topic. For each candidate
topic, keep: the ticket count, a representative set of the actual resolution
steps, and the source thread IDs.

## Step 3 — Freshen the KB repo and check existing coverage

```sh
if [ -d /workspace/repo/.git ]; then
  cd /workspace/repo && git fetch origin && git checkout main && git reset --hard origin/main
else
  git clone --filter=blob:none https://github.com/{{kb_repo}}.git /workspace/repo
  cd /workspace/repo
fi

grep -ril "<likely topic keyword>" {{kb_path}} 2>/dev/null
```

For each candidate topic from Step 2, check both `{{kb_path}}` in the repo and
the ledger's covered-topics list. A topic is a **gap** only if neither shows
an existing article for it. A topic with an article that's out of date is not
a gap for this skill — that's a refresh, not a new draft; skip it here.

## Step 4 — Rank and select this week's batch

Rank remaining gap topics by ticket volume (how many resolved threads
recurred on it). Re-check against the ledger's "seen before, below bar"
entries — a topic that just crossed the volume threshold this week is
promoted; a topic that's been circling near the bar for months without
crossing it stays logged, not drafted. Take the top 3–5 as this week's batch.

## Step 5 — Isolated drafting branch

```sh
cd /workspace/repo
BRANCH="kb-gap/$(date +%Y-W%V)"
git checkout -b "$BRANCH" origin/main
```

One branch per weekly run.

## Step 6 — Draft each article from real resolutions

For each topic in the batch:

1. Write the article under `{{kb_path}}`, matching the existing article
   format and tone in that directory.
2. Base every step in the article on the actual resolution steps gathered in
   Step 1 — never invent a fix the source tickets don't support.
3. Strip all customer names, account identifiers, and specifics; generalize
   to the reusable version of the question and answer.
4. Note the ticket count and topic in the PR description (not in the article
   itself) so the reviewer can judge whether the batch reflects real demand.

## Step 7 — Commit

```sh
cd /workspace/repo
git add {{kb_path}}
git commit -m "kb: draft $(date +%Y-W%V) batch

$(for each topic: echo "- <article path>: <ticket count> resolved tickets")"
```

## Step 8 — Open the PR (draft only, never publish)

```sh
cd /workspace/repo
git push origin "$BRANCH"
gh pr create --repo {{kb_repo}} --base main --head "$BRANCH" \
  --title "kb: draft $(date +%Y-W%V) batch" \
  --label kb-gap \
  --body "Generated by the ticket-to-KB agent. Each article was drafted from
the real resolutions used to close its cluster of Plain tickets, with
customer specifics stripped. Per article: the topic, the resolved-ticket
count that triggered it, and source thread IDs for verification. This PR is
never merged by the agent — a human reviews, edits, and decides what
publishes."
```

## Step 9 — Update the ledger

Append a dated entry to `.kortix/memory/kb-gap-mining-log.md` (see
`<ledger-format>`).

</workflow>

<ledger-format>
Lives at `.kortix/memory/kb-gap-mining-log.md`. Every run appends a dated
entry with: run timestamp, branch, PR link (or "not opened — nothing cleared
the bar"), a **Drafted topics** table (topic / article path / ticket count /
source thread IDs), the **full candidate list** considered that week
including gaps that didn't clear the volume threshold (topic / ticket count /
status: covered, drafted-pending-review, or below-bar), and **blockers for
next run**.
</ledger-format>

<guardrails>
- **Draft only, never publish.** The agent opens a PR against an isolated
  branch and stops. It never pushes to the live docs branch and never merges
  its own work.
- **Real resolutions only.** Every drafted step must trace back to an actual
  ticket resolution from Step 1. Never fabricate a fix the source tickets
  don't support.
- **No customer detail in a draft.** Names, account identifiers, and
  ticket-specific context are stripped before anything is written to
  `{{kb_path}}`.
- **Read-only tickets.** Plain access is read-only. The agent cannot edit,
  close, or reply to a ticket while mining it.
- **`{{kb_path}}` is the only write surface.** Files outside that path in
  `{{kb_repo}}` are read-only to this agent.
- **Sandbox isolation.** Drafts are written and reviewed on an isolated branch
  in the session sandbox. Nothing reaches the repo until `git push` runs.
- **Secrets scoped.** `PLAIN_API_KEY` and `GH_TOKEN` are injected at runtime,
  never written to disk or logged.
- **One PR per run, one run per week.** If a prior PR is still open, don't
  duplicate its topics — extend it or wait for review.
- **Volume plus absence, not either alone.** A single ticket never justifies a
  draft, and an existing-but-stale article is never redrafted here.
</guardrails>

</skill>
