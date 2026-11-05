# Workspaces — UX spec for PR 1 (branch `workspaces`)

The implementation contract for the first PR. Every screen below already
exists; this PR simplifies it. Read `README.md` for the why.

## Model the UI shows

- A **workspace** is one `projects` row and the `accounts` row that owns it.
  The workspace id in URLs stays `project_id` (decision D2).
- A legacy account with several projects shows each project as its own
  workspace row. Nothing else about those accounts changes in this PR.
- An account with 0 projects is **not** a workspace and is never listed.
  An existing user whose only accounts are empty sees the create-or-join
  screen. "Create workspace" reuses the newest account they own that has 0
  projects (so a plan or credits they already hold stay), else creates one.
- Workspace name = account name = project name. Renaming the workspace writes
  both rows.

## 1. Signup and landing (D3, decided by Marko 2026-11-05)

- No account is created at signup, on `GET /v1/accounts`, on `/accounts/me`,
  or in any middleware. A user has 0 workspaces until they create or join.
- The door (`/projects/start`):
  - 1 obvious workspace (the remembered one, or the only one) → open it.
  - otherwise → `/projects` (the chooser).
- The chooser (`/projects`, `ProjectSelector`) is the create-or-join screen:
  - **0 workspaces, 0 invites:** title "Create a workspace", one sentence
    ("A workspace is where your company works with Kortix: people, agents
    and everything they make."), the create form inline or one primary
    button "Create workspace". Below, one quiet line: "Invited? Open the
    invite link from your email, or ask an admin to invite {email}."
  - **invites pending:** an "Invitations" group first, each row with the
    workspace name, inviter, role and **Join**. Then "Create a workspace".
  - **1+ workspaces:** one flat list, 1 row per workspace (icon, name, role),
    no per-account grouping, no "Create in {account}", no "ask an admin".
    Search appears at 8+ rows. One "Create workspace" action.
- Self-host with `KORTIX_RESTRICT_ACCOUNT_CREATION` and no invite: no create
  action; "Ask an admin to invite {email}."

## 2. Create (`/new`)

- One form: name, icon. Advanced keeps the repository source (managed or
  GitHub).
- No account picker. Submit creates the whole workspace (reuse-or-create the
  account, then provision its project) through SDK `createWorkspace`, and
  keeps `WorkspaceHandoff` with its 4 steps.
- "Create account" (`CreateAccountModal`) is deleted from every entry point.

## 3. Switcher (sidebar, command palette, mobile sheet)

- One flat list of workspaces, the current one checked. Search always.
- Rows: workspace icon + name. Pending invitations group on top.
- Actions at the bottom: "Create workspace", "Workspace settings".
- Removed: account headings, "Create in {account}", "Create account",
  "Account settings" as a separate row.

## 4. Workspace settings

One settings surface per workspace: the project admin page
(`/projects/<id>/admin/<section>`) absorbs the account hub's panes.

Rail groups:

| Group | Sections |
|---|---|
| Workspace | General (name, icon, security policy from the account Settings pane), Branding, Git repo, Sandbox templates, Feature flags, API keys |
| Library | Connectors, Secrets, Skills, Drives, Apps, Triggers, Models, Repo |
| People | Members, Groups, Roles, Identity, Audit log, Help |
| Billing | Plan, Usage |

- The account hub modal (`?accountId=&accountTab=`) stays as the router for
  old links: each tab opens the matching section of the current workspace.
- The account "Git" pane (GitHub installations) merges into Git repo.
- The account "Projects" access tab: **open decision D5** (see
  `decisions.md`).

## 5. Copy

- "project", "account" (meaning the container), "organization" (meaning the
  container) → "workspace".
- Keep: "Slack workspace", GitHub "organization", "your organization" meaning
  the customer's company or identity provider, `/workspace` paths, code
  identifiers, ICU placeholder names (`{project}`), CLI flags and env vars.
- Sandbox meaning of "workspace" → "sandbox" ("The sandbox went to sleep").
- Brand kit `references/verbal/voice-and-tone.md` noun table: `workspace`
  becomes canonical; `project`, `account` (as the container), `organization`
  join the Never column. Record the decision in `references/decisions.md`.
- Every locale gets its own word: de "Workspace", fr "espace de travail",
  es "espacio de trabajo", it "workspace", pt "espaço de trabalho",
  ja "ワークスペース", zh "工作区", sr "radni prostor".

## Out of this PR

- `/workspaces/<id>` URLs and `/v1/workspaces` aliases (mechanical, no screen
  changes).
- The `409` on a second project per account (needs the e2e fixtures that
  create several projects per account reworked first).
- Splitting the legacy multi-project accounts (D4).
