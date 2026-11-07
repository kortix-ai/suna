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

## 3. The workspace menu and the switcher (sidebar, command palette, mobile sheet)

The menu opens from the workspace name (Slack's "Acme ▾"), top to bottom
(review finding 21, `workspaceMenuGroups` in
`packages/ui/src/workspace/sidebar/workspace-menu-model.ts`):

1. Header: the workspace icon, its name and the viewer's one role.
2. "Invite people to {name}" (`project.members.manage`): Members with
   `?invite=1`, which opens the invite form. "Workspace settings" (the
   Customize › Workspace settings gate): the one Settings panel.
3. "Switch workspace" (the list, with the pending-invitation count) and
   "Create workspace".
4. "Preferences" (the person's own settings; it keeps Mod+,), Apps and
   extensions, Appearance, Help, Download app.
5. "Leave {name}" (never the last owner; it confirms first) and Log out, with
   the signed-in email under it.

Rename is in Workspace settings › General, not in the menu.

The list (switcher submenu, chooser, `/workspaces/start`, mobile sheet and
Workspaces page) is one request, `GET /v1/workspaces` with every state
(`listWorkspaces({ includeInactive: true })`):

- One flat list, most recently opened first, the current one checked. Search
  in the submenu always; on the chooser at 8+ rows.
- Pending invitations on top.
- `active` rows open. A `setup_required` row (it pays, no repository yet)
  offers "Set up" (`POST /v1/workspaces/:id/setup`). A `deleting` row (owners
  only) reads "Deleting on {date}" and offers "Restore"
  (`POST /v1/workspaces/:id/restore`). Neither opens until its action ran.
- The chooser shows the create handoff whenever a create is in flight, even
  after the new workspace joined the list (review finding 38).
- Removed: account headings, "Create in {account}", "Create account",
  "Account settings" as a separate row, the top-level "Settings" row that
  opened personal settings.

## 4. Workspace settings

One Settings panel per workspace at `/workspaces/<id>/admin/<section>`. The
registry is `packages/shared/src/workspace-settings.ts` (design.md C7): the
web rail, the CLI, the API emails and the My Kortix prompt read it. No tab
bar sits over the panel; its one rail is the navigation.

| Group | Sections |
|---|---|
| Workspace | General (name, icon, workspace ID, Pause all triggers), Security (MFA, session policy, session oversight, key rules), Branding, API keys (one list: a key acts as you, an agent or a bot), Capture (while Capture is on) |
| Library | Models, Connectors, Secrets, Skills, Drives, Apps, Triggers, Sandbox, Git (the repository connection), Repository (the repository's files, with Drive on) |
| People | Members (one roster, one role per person, access requests on top, invite), Groups, Roles, Identity, Audit log |
| Billing | Plan, Usage |
| Advanced | Feature flags |
| Danger zone | Leave workspace, Delete workspace |
| Support | Help, in the rail's footer |

Restructured 2026-11-07 (Marko): Sandbox moved to Library, Feature flags to
Advanced, the Danger zone out of General into its own row, Help to the rail
footer. Every section id is unchanged, so every `/admin/<id>` link still opens
its section. Git and Repository stay two rows: Git configures the repository
connection behind the settings gate; Repository is the file browser behind the
`drives` flag. Access requests stay at the top of Members, where they are
decided; they render only while a request is pending.

- Each row keeps its own permission gate. `/admin` opens General, else the
  first section the caller may open.
- Old links land on their section: `/admin/access` and `/admin/access-projects`
  → Members, `?accountId=&accountTab=settings` → Security, `/settings/tokens`
  → API keys, `/admin/loops` → Triggers, `/workspaces/<id>/members` → Members,
  `/projects/<id>/admin/<s>` → `/workspaces/<id>/admin/<s>`.
- Delete workspace: a typed confirmation, "Deletes this workspace for every
  member. You can restore it for 14 days." (`DELETE /v1/workspaces/:id`).
- API keys mints workspace keys only (`POST /v1/workspaces/:id/tokens`, scope
  "This workspace"). A person's keys bound to no workspace are in Preferences ›
  Personal keys (`GET /v1/me/tokens`), scope "Every workspace".
- Members: the invite is "Invite people to {workspace}": email chips, one
  role (Member, Manager, Admin), optional expiry. A `split_pending` account
  keeps its per-workspace grants (the old Access tab) under the roster until
  the split runs.
- Preferences is the person's own overlay (`/workspaces/<id>/settings/<tab>`):
  Profile, Security, Appearance, Notifications, Language & shortcuts,
  Personal keys, MCP, My computer, and the list of their workspaces in the
  rail. "Delete my account" shows the plan (`GET /v1/account/deletion-plan`):
  workspaces deleted, workspaces left, and the ones to hand over first.
- The split notice (C9) shows on the workspace home and on General for 30
  days after a split.

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
