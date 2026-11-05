---
title: Workspaces — one account, one project, one concept (the Slack model)
status: planning — direction approved by Marko 2026-11-05; decisions D2–D4 open
owner: marko
updated: 2026-11-05
---

# Workspaces

## The problem

Users do not understand "project". They read it as a small unit of work that
they create per task. A teammate asked whether a new content system needs a
new project. The answer is no: one company works in one place.

The data agrees. Kortix already behaves like a Slack workspace; the product
names it wrong.

Prod, read-only aggregates, 2026-11-05:

| Measure | Count |
|---|---|
| Accounts | 49,068 |
| Accounts with 0 active projects (personal accounts bootstrapped at signup) | 40,618 |
| Accounts with exactly 1 active project | 8,049 (95.3% of accounts with a project) |
| Accounts with 2+ active projects | 401 (1,034 projects); max 23 |
| … that opened 2+ projects in the last 30 days | 25 |
| … that ever purchased credits | 36 |
| … active 2+ and ever purchased | 11 |
| … with an active enterprise contract | 0 |
| Users who belong to 2+ accounts | 58 of 49,032 |

The copy is also inconsistent. In `apps/web/translations/en.json` the word
"workspace" already means 4 things: the account, the project, a Slack
workspace, and the sandbox ("The workspace went to sleep").

## The decision

**A workspace is the only top-level concept, exactly like a Slack workspace.**

- 1 workspace = 1 company. Each workspace is independent.
- Everything is per workspace: members, roles, groups, SSO, MFA policy,
  billing, credits, plan, secrets, connectors, agents, skills, Drive,
  sessions, triggers, apps, the model gateway, audit.
- A user can belong to several workspaces and switches between them.
- There is no organization above a workspace. An Enterprise-Grid-style layer
  (one contract over many workspaces) is added only when a real enterprise
  customer asks for it.
- "Project" disappears from the UI, CLI and docs. The API and SDK get
  `workspace` names. The old `project` names stay working as `@deprecated`
  aliases.
- Internals keep their names: tables, columns, `apps/api/src/projects/`. A
  physical rename happens only if it pays for itself.

### Mapping onto today's model

| Concept | Today | After |
|---|---|---|
| Workspace | `accounts` row + its one `projects` row | one thing in every user-facing surface |
| Billing, members, IAM, SSO | `accounts` | unchanged storage, shown as workspace settings |
| Config repo (`kortix.yaml`, agents, skills) | `projects.repo_url` | the workspace's config repo, invisible to most users |
| Code repos | one per project | later: connected resources of a workspace (stage 4) |
| Personal account | bootstrapped at signup | see D3 |

## Glossary (the copy contract)

| Word | Means | Never means |
|---|---|---|
| Workspace | the company's Kortix (account + project) | a sandbox, a Slack workspace, a folder |
| Computer | the session's machine/sandbox | a workspace |
| Slack workspace / Teams tenant | the chat platform's own unit; always qualified | a Kortix workspace |
| Space | a channel-like room inside a workspace (`project_spaces`) | a workspace |

Rename the code identifiers that collide with "workspace" in the same branch:
`chat_installs.workspace_id` / `chat_threads.workspace_id` (Slack team id),
`capture_workspaces`, and `packages/ui/src/workspace/` (layout code).

## Prior attempt: #5480 (closed, not merged)

`refactor/projects-to-workspaces` (head `ca3630c5f0`, 2026-08-11) renamed
Project → Workspace across 2,296 files (+76,783 / −46,107) in one PR. It fell
799+ commits behind and could not be rebased. Marko closed it 2026-09-26; the
vocabulary decision stood.

What to reuse: its compatibility-alias design — deprecated `/v1/projects`,
`/projects/**` web redirects, `kortix projects`, `KORTIX_PROJECT_ID` fallback,
every SDK `Project*` export kept.

What it did not do: it kept many projects per account ("route account entry
points to the account default Workspace"). This plan makes account:project
1:1.

**The rule this time: no big-bang PR.** Each stage below is a PR that lands
on `dev` within a day or two. Each one is green and shippable alone.

## Size of the surface

| Surface | Count (2026-11-05, `dev` 79871435a6) |
|---|---|
| API routes under `/projects` | 491 of 991 (`tests/spec/routes.generated.json`) |
| SDK exports containing `Project` | 298 |
| English strings containing "project" | web 1,157, `@kortix/ui` 487, mobile 15 — 9 locales each |
| Web pages under `/projects` | 33 `page.tsx` |
| `KORTIX_PROJECT_ID` references | 436 |
| Manifest `project.*` actions | 68 |

## Stages

Each stage is its own PR on branch `workspaces` or a sub-branch merged back.

1. **Spec** (this folder).
2. **Copy.** All catalogs: "project" → "workspace", the other meanings of
   "workspace" → the glossary word. A ratchet test: the count of "project"
   in user-facing English catalogs can only go down, so new copy cannot drift
   back. Visual/brand change → held for Marko's merge OK.
3. **Web routes.** `/workspaces/<id>/…` is canonical. Every `/projects/<id>/…`
   URL redirects (bookmarks, shared session links, emails).
4. **Navigation and settings.** The account switcher and the project selector
   become one workspace switcher. Account settings + project settings become
   one Workspace settings. "New project" is removed; "Create workspace"
   creates the account and its project in one step.
5. **API.** `/v1/workspaces/…` as the primary names; `/v1/projects/…` stays
   as a deprecated alias. Route manifest and flows updated.
6. **SDK.** `workspace` names added (TDD, the `sdk` skill); every `Project*`
   export kept with `@deprecated`. No export removed.
7. **CLI and runtime env.** `kortix workspaces`, `KORTIX_WORKSPACE_ID`
   (kortixd falls back to `KORTIX_PROJECT_ID`). `kortix projects` stays as a
   deprecated alias.
8. **Docs and skills.** `apps/web/content/docs/developers.mdx`,
   `packages/sdk/README.md`, every skill that says "project".
9. **Enforce 1:1 for new data.** Creating a second project in an account
   returns `409`. Then the legacy split (D4), then a unique partial index on
   `projects(account_id) where status = 'active'`.
10. **Later, separate initiative:** code repos as connected resources of a
    workspace, so a developer with 5 repos has 1 workspace, not 5.

## Open decisions

See `decisions.md`.

## Pick it up

- Worktree: `../suna-workspaces`, branch `workspaces`
  (`pnpm worktree start workspaces`).
- Prod numbers: read-only `DATABASE_URL` from `apps/api/.env.prod`,
  aggregates only, no IDs or names in tracked files.
