---
name: coding
description: "Route code, repository, and data/SQL work to isolated Kortix sessions instead of burning your main context on it. Use when asked to implement a feature, fix a bug, make failing tests pass, work a ticket/issue, refactor, navigate or change a codebase, ship a PR, review a pull request, or run SQL/warehouse analysis against a dataset — and when the user wants two agents or parallel reviewers/investigators on the same work. Covers the explore-vs-session routing call, deciding where the code lives (this project's repo vs cloning an external GitHub repo) or where the data lives, finding the repo with gh, spawning sessions in parallel, dual PR reviews, and reporting results back. Triggers: 'implement', 'fix the bug', 'make the tests pass', 'work this ticket', 'refactor this', 'open a PR', 'review this PR', 'run two agents on it', 'query the warehouse', 'analyze this dataset'."
defaultProjectInstall: true
---

# Coding

This skill is about *routing* code work, not doing it inline. When a request means navigating a repository or changing source files, the heavy lifting belongs in an isolated session sandbox — not in the context you're orchestrating from. Your job is to make the setup decisions, hand off cleanly, and report back.

Reach for this skill for repo-shaped requests: implement, fix, refactor, make tests pass, work a ticket, open or review a PR. It also covers data-shaped work that deserves the same treatment — SQL/warehouse analysis, dataset-backed investigations, or a mix of code and analytical output (see *Data, SQL, and Warehouse Work* below). Skip it for conceptual questions that touch no repository or dataset — answer those directly.

## Two ways to delegate, pick by weight

Kortix gives you two delegation paths. Choosing the right one is the whole game.

**The `explore` subagent — cheap, read-only recon.** When you need a fast answer about a codebase ("where is auth handled", "what calls this function", "does this repo use Vite or Webpack") and you do *not* need to change anything, invoke the read-only `explore` subagent via the `task` tool or an `@explore` mention. It searches and reports a conclusion instead of dumping files into your context. Use `scout` instead when the answer lives in an external dependency you'd need to pull source for.

**A background session — the real worktree.** When the task is to *change* code — implement, fix, refactor, run a test suite, push a branch, open a PR — spawn a background session with the Kortix sessions flow (`session_start_background`, or `session_spawn` for parallel work). Each session is its own isolated VM sandbox with full tooling, so it can install, build, run, and commit without touching your environment. Read results back with `session_read`. This is the equivalent of handing the job to a dedicated coding agent.

**Keep the codebase out of your orchestrating context.** Don't drag a large or external repo into the session you're routing from — don't crawl its file tree, read its source, or fetch raw files from GitHub to "understand the architecture" first. That's what the delegate is for, and it explores far more efficiently than you can from the outside. Pass tickets, requirements, and constraints in the prompt; let the session discover the code. (Small, self-contained edits inside the current project are fine to do directly — the rule is about not importing an entire codebase into your head before delegating.)

## Decide where the code lives, then say so

Before you spawn anything, settle the workspace question and state it plainly in the session prompt. Don't make the delegate guess from phrases like "in the repo." Pick one:

- **This project's repo.** The session sandbox is already an ephemeral branch of this project's `/workspace`. For substantial in-project work, spawn a session scoped to the project (pass `project=<name>`) so it gets its own clean branch. Open the prompt with: *"Work in this project's workspace. No clone needed."*
- **An external GitHub repo.** Spawn a session and have it clone the target itself with `gh repo clone <org>/<repo>` (or `git clone`). Open the prompt with: *"Clone https://github.com/org/repo into your workspace, then work there."* Make sure GitHub is connected first — if it isn't, mint a setup link to connect it before spawning (see the `kortix-system` credentials reference) rather than handing the session a repo it can't reach.
- **No repo at all.** For coding-adjacent work that needs no repository files, say *"No repository needed"* and consider whether a session is even warranted.

If a GitHub repo is clearly involved but you can't pin down the URL, resolve that *before* spawning — ask the user rather than letting a session burn startup time guessing whether to clone.

## Finding an external repo

When the target is on GitHub and the user didn't paste a URL, find it with `gh` (don't reach for generic web-browsing tools — `gh` and `git` are the direct path):

1. **Check project memory** — `view .kortix/memory` for the repo, project, or related names.
2. **List the user's orgs**, then search inside the likely one: `gh api user/orgs --jq '.[].login'`, then `gh search repos "<query>" --owner=<org> --limit=5`.
3. **Ask** if neither lands it.

Resolve the URL yourself and put it in the session prompt — don't open the repo's files to confirm it; a glance at the repo description from search results is enough.

## Running sessions in parallel

When the user wants more than one agent on the work ("run two agents", "have a couple of approaches going at once"), spawn them together in a single turn — fire all the `session_spawn` calls in one batch rather than waiting for the first to finish. Each runs in its own sandbox, so they make progress simultaneously. Give every session a distinct objective so their results are worth comparing, then collect them with `session_read`.

## Reviewing a pull request

For PR reviews, run two reviewers concurrently to get independent reads. Spawn two background sessions in a single batch, each told to load the `code-review` skill and check out the same PR. To get genuinely different perspectives rather than two of the same opinion, give the two sessions different models. Put the full PR reference (URL, or `owner/repo` plus PR number) in each prompt. If owner, repo, or PR number are ambiguous, ask before spawning.

When both come back, read each result and write up:

- **Summary** — one or two lines per reviewer on what they found.
- **Where they agree** — issues both flagged; treat these as high-confidence.
- **Where they split** — any disagreements, with your take on which side is stronger.
- **Solo catches** — findings only one reviewer raised.
- **Call** — approve, request changes, or needs-discussion.

If only one session returns usable output, proceed with it and label the writeup as single-reviewer.

**Posting comments back to the PR.** Only do this if the user actually asked for it ("comment on the PR", "post the feedback", "auto-comment"). If they did:

1. Pull the current diff: `gh pr diff <number> --repo <owner>/<repo>`.
2. For each finding that names a `file:line`, confirm that line is in the diff; drop findings whose line isn't.
3. Post one review via `gh api repos/<owner>/<repo>/pulls/<number>/reviews` with `event` set to `"COMMENT"` — never `APPROVE` or `REQUEST_CHANGES`. The top-level `body` carries your call plus summary; each inline comment carries severity, the issue, and a concrete suggested fix. If nothing maps to a diff line, post just the top-level body with an empty comments array. Confirm back to the user with the PR link.

If the user didn't ask, end your reply with a single offer to post the findings as inline comments.

## Mixed discovery-plus-coding requests

Some asks bundle research with implementation ("find the open tickets and knock them out"). Split the work: *you* do the discovery — locate the repo URL, read the tickets/issues, gather requirements, check memory — and write that context to workspace files. Then spawn the session with the repo decision and pointers to those files in the prompt. Discovery here means finding the repo and the requirements, not reading source or mapping the architecture; that stays the session's job.

## Data, SQL, and Warehouse Work

This skill also covers work that's data-shaped rather than pure code: SQL analysis against a warehouse, dataset-backed investigations, or a mix of code and analytical output. The same routing rule applies — delegate substantial data work to a background session rather than running it in your orchestrating context, and let the child session explore the schema itself.

- **If the data source is clear**, include it directly in the session prompt: connector/warehouse name, schema hints, date ranges, and the exact question to answer.
- **If the data source is unclear**, resolve that first — ask, or check project memory/connectors — rather than delegating blindly and hoping the session finds the right table.
- **For file-based analysis**, include file paths and the desired output (charts, CSVs, summaries) in the prompt.
- **Parallel technical investigations** follow the same pattern as parallel coding sessions: spawn them together in one batch, each with a distinct angle, then read back and synthesize agreements, disagreements, and unique findings.
- Trivial conceptual questions that need no query or dataset access should still be answered directly — don't spin up a session for something answerable from general knowledge.

## When a session comes back empty

If a background session returns with nothing usable — it hit its step limit and stopped, or produced no result — **stop and ask the user with the `question` tool before doing anything else.** Do not quietly retry, do not take over the coding yourself, do not spawn a replacement on a hunch. Surface what happened and ask whether to continue, adjust scope, or hand it off differently. A stalled session usually means the objective was too broad or under-specified, and a blind retry just burns another sandbox.

## Closing the loop

Once a session finishes cleanly:

1. Read its full output, then read any files it produced.
2. Surface deliverables inline with the `show` tool rather than describing them.
3. Give the user a tight report:
   - **What changed** — the implementation/fix/refactor, with specific files, functions, and the approach taken.
   - **Verification** — tests added or run, and how they came out.
   - **Decisions** — any trade-offs or design calls worth knowing.
4. If a PR was opened, lead with the link.

Be concrete — name files and functions, not "made some changes." The user should understand the outcome without reading the diff. Don't re-run the whole task to double-check unless the result itself shows a failure or skipped verification.

## Worked examples

**"Make the failing tests pass in our payments service."**
In-project repo. Spawn one background session scoped to the project: *"Work in this project's workspace, no clone needed. The CI test suite is failing — find the broken tests, fix the cause, and get them green. Report which tests were failing and what the root cause was."* Read the result, summarize, surface the diff with `show`.

**"Implement ENG-412 in github.com/acme/ledger."**
External repo. Find/confirm the URL, gather the ticket details yourself, write them to a workspace file. Then: *"Clone https://github.com/acme/ledger into your workspace and work there. Implement ENG-412 — requirements are in /workspace/notes/ENG-412.md. Add tests and open a PR."* On completion, report the changes and include the PR link.

**"Get two agents on this refactor and compare."**
Spawn two sessions in one batch with the same objective but different models, each scoped to the repo. Read both back and present the two approaches side by side with a recommendation.

**"Review PR #88 in acme/ledger and post comments."**
Spawn two review sessions in one batch (different models), each loading `code-review` and checking out PR #88. Synthesize agreements, splits, and solo catches into a recommendation, then post a single `COMMENT` review via `gh api` with inline comments mapped to diff lines.
