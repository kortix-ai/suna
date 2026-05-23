---
name: coding-and-data
description: "Use for routing work that mixes coding, repository implementation, SQL/data analysis, or technical investigation and should often be delegated to a background session with clear context and boundaries."
---

# Coding And Data

Use this skill when a task involves repository work, implementation, code review, SQL analysis, data processing, or a mix of code and analytical output.

## Core Rule

Prefer background sessions for substantial coding or data work. Read `skills/KORTIX-system/sessions/SKILL.md` and use `session_start_background` / `session_spawn`, then inspect results with `session_read`.

## When To Delegate

Delegate when the task requires:
- navigating a codebase
- implementing or fixing code
- running a substantial code review
- analyzing warehouse or dataset-backed questions
- parallel coding reviewers or parallel technical investigations

Do not delegate trivial conceptual questions that can be answered directly.

## Repository Tasks

- Identify the correct repo or project context first.
- Gather tickets, issue links, requirements, PR URLs, or other non-code context yourself.
- Then start a background coding session with the relevant context and file or repo boundaries.
- Let the child session explore the codebase itself.

## Data Tasks

- If the data source is clear, include it in the background-session prompt.
- If the data source is unclear, resolve that first instead of delegating blindly.
- For warehouse or SQL work, include connector names, schema hints, date ranges, and the exact question.
- For file-based analysis, include file paths and desired outputs such as charts, CSVs, or summaries.

## Parallel Work

If the user explicitly wants multiple reviewers or multiple technical angles:
- start multiple background sessions in parallel
- give each one a distinct goal
- read the results back and synthesize agreements, disagreements, and unique findings

## Code Review Pattern

For substantial PR review:
- extract owner, repo, and PR number or use the full PR URL
- start parallel background sessions if multiple reviewers are desired
- give each session the PR context and review objective
- after completion, synthesize findings into:
  - summary
  - agreements
  - disagreements
  - unique findings
  - final recommendation

If the user wants comments posted back to the PR, use the real GitHub CLI flow only after synthesizing the review.

## Post-Completion

After a background coding or data session completes:
- read the session output carefully
- read any generated files or artifacts it produced
- summarize what was done, what was verified, and any important decisions
- present deliverable files with `show`

Do not blindly rerun the whole task unless the result itself indicates a failure or missing verification.
