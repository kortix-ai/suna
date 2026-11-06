---
title: Workspaces — one account, one project, one concept (the Slack model)
status: Release 1 in progress (PR #11857, branch `workspaces`) — plan approved by Marko 2026-11-06 (D8–D11); Releases 2 and 3 specified in design.md, not built
owner: marko
updated: 2026-11-06
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
| Sandbox / cloud computer | the session's machine (brand kit noun table) | a workspace |
| Computer | a person's own machine connected to Kortix (brand kit) | a sandbox, a workspace |
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

## Status (2026-11-06)

- The current spec is `design.md` (§3 Release 1, §4 Release 2, §5 Release 3).
  The stages below are the 2026-11-05 plan, kept for history.
- D1–D5 and D8–D11 are decided (`decisions.md`). D7's "old DB names stay" is
  superseded by D8.
- Release 1 identity (sub-branch `ws-r1-identity`): `kortix.workspaces` is a
  table kept in sync by triggers, the 44 expand tables carry `workspace_id`,
  the store answers with shadow reads, delete closes the account, "Delete my
  account" deletes the person, and a create never reuses an account.

## Open decisions

See `decisions.md`.

## Pick it up

- Worktree: `../suna-workspaces`, branch `workspaces`
  (`pnpm worktree start workspaces`).
- Prod numbers: read-only `DATABASE_URL` from `apps/api/.env.prod`,
  aggregates only, no IDs or names in tracked files.

## Next PR: one scope — the workspace (Marko 2026-11-05)

Marko: "there will just be Workspace scopes not the account level or project
level, just 1 type & then agent either can or cannot, no more of this confusion
having 2 sys".

Today there are two scope systems:

- IAM: `role_assignments.scope_type` is `account` or `project`; the action
  catalog has `account.*` and `project.*` actions; owners and admins are
  implicit managers of every project.
- Credentials: account tokens vs project/session-scoped PATs, fenced by a
  per-route allowlist in `enforceTokenProjectScope`
  (`apps/api/src/middleware/auth-scope.ts`). An agent in a session ran
  `kortix feedback` and got 403 from that fence (PR 1 allows `POST /v1/feedback`
  as the stopgap).

Target:

1. One scope: the workspace (id = `project_id`). Every grant, role and
   credential names one workspace. Account-scope assignments become workspace
   assignments; `account.*` and `project.*` actions become `workspace.*`
   (old names kept as aliases on the wire for old CLIs and daemons).
2. One fence: a credential reaches its own workspace and nothing else. The
   allowlist is deleted.
3. One decision: `authorize(actor, action, workspace)`. A person or an agent
   (`agent_session` in `iam/actor.ts`) either holds the grant or does not. An
   agent never inherits workspace administration (billing, members, roles,
   SSO, keys) from the person who started its session.
4. Legacy accounts with 2+ projects: each project is a workspace for IAM;
   actions on the shared account rows (billing, members, SSO) need the grant
   on every project of the account, or the owner role, until the split.
5. Proof before cutover: a verdict-parity table over every route in
   `tests/spec/routes.generated.json` × credential kind × (1:1, legacy) ×
   role, old engine vs new, with every difference listed and approved. The
   2026-08 RBAC cutover (#6554) used the same harness shape.
