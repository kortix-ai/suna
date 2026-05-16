# Kortix Repo-Native V0

Status: draft implementation target

This is the clean starting point: a Kortix project is a git repo with OpenCode-compatible config, a local runtime, one default Kortix agent, and a deploy path to managed sandbox compute.

The product should feel simple:

```bash
kortix init my-company
cd my-company
kortix start
kortix deploy
```

`kortix start` opens the local Kortix dashboard, starts the local control plane, reads the project files from the current repo, and creates sessions by booting sandboxes from a snapshot of that project machine.

`kortix deploy` binds the repo to Kortix Cloud and runs the same project in managed compute.

## 1. Core Model

```text
Project
  = git repo
  + kortix.toml
  + .opencode config
  + .kortix config and memory files
  + optional runtime image
  + cloud bindings

Session
  = one user or automation run
  + one sandbox snapshot of the project machine
  + one branch/worktree
  + optional proposal back to project
```

The repo is the source of truth for project behavior. The running session sandbox is a working copy.

This means project files should be read from git or a local checked-out repo, not treated as random mutable files inside whichever sandbox is currently alive.

The product should not start with worker/orchestrator/project-maintainer role sprawl. V0 has one default agent:

```text
Kortix Agent
  = the main agent for the project
  + full awareness of the Kortix operating model
  + access to project config, files, channels, triggers, apps, and scoped secrets
  + ability to propose durable changes back to the repo
```

Additional agents can exist later, but they are not the default mental model.

The cloud database stores:

- project owner, org, repo URL, default branch, manifest path,
- deployment and runtime state,
- secrets and connector bindings,
- users, groups, permissions,
- session metadata and event indexes,
- billing and provider configuration.

The repo stores:

- agents,
- skills,
- commands,
- triggers,
- channels,
- app/service definitions,
- curated memories,
- docs,
- tests,
- runtime configuration.

The sandbox stores:

- scratch files,
- checked-out working tree,
- in-progress edits,
- local caches,
- runtime-specific state.

Anything that should persist as project truth must go through a save path: commit, PR, merge request, or explicit state export.

## 1.1 Runtime Loop

The loop is:

```text
core project repo
  -> kortix start
  -> web dashboard
  -> new session
  -> isolated sandbox snapshot
  -> agent works freely
  -> diff / memory update / config update
  -> ask to contribute back
  -> commit / PR / proposal
  -> core project repo updated
```

The important point is that the session sandbox is disposable. The persistent project is the repo plus approved durable state.

The agent does not need a big explanation in the UI. The Kortix system prompt should deeply explain the operating model to the agent itself:

- you are running inside a session sandbox,
- project truth lives in the repo,
- `.opencode` defines the agent runtime,
- `.kortix` defines project memory, triggers, channels, apps, permissions, and local state,
- edits in the sandbox are not durable until proposed back,
- use the proposal path for persistent changes,
- use scoped connectors/secrets instead of leaking credentials,
- understand and expose triggers, channels, apps, files, sessions, and project context.

## 2. Default Project Structure

`kortix init my-company` creates this:

```text
my-company/
  kortix.toml
  Agent.Dockerfile
  README.md
  .gitignore

  .opencode/
    agent/
      kortix.md
    skill/
    command/
    plugin/

  .kortix/
    CONTEXT.md
    MEMORY.md
    triggers.yaml
    connectors.yaml
    channels.yaml
    apps.yaml
    permissions.yaml
    state/
      .gitkeep

  docs/
  scripts/
  tests/
```

`.opencode` remains the runtime-native config because OpenCode is the first execution engine.

`.kortix` is the platform layer around it: project memory, triggers, connectors, channels, apps, permissions, and local runtime state.

`kortix.toml` is the human-facing manifest that can compile into `.opencode` and `.kortix` files over time. V0 can allow both direct file editing and manifest-generated config, but the direction should be one canonical manifest.

`.opencode/agent/kortix.md` is the default agent. It should not describe fake team roles. It should describe the actual Kortix machine model in detail so the agent knows where it is running, what is persistent, what is ephemeral, and how to propose changes back.

Recommended `.gitignore`:

```gitignore
.kortix/state/*
!.kortix/state/.gitkeep
.kortix/cache/*
.kortix/runtime/*
node_modules/
.env
.env.*
```

## 3. Manifest V0

```toml
schema = "https://schemas.kortix.com/project/v0"
name = "my-company"
description = "Company command center"

[runtime]
engine = "opencode"
mode = "ephemeral" # ephemeral | persistent | hybrid
image = "kortix/runtime:latest"
dockerfile = "Agent.Dockerfile"
workdir = "/workspace"

[source]
default_branch = "main"

[storage]
persistent_paths = [
  ".kortix/CONTEXT.md",
  ".kortix/MEMORY.md",
  ".kortix/memory",
  "docs",
  "outputs"
]

[agent]
name = "kortix"
instructions = ".opencode/agent/kortix.md"

[permissions]
filesystem_write = ["docs", "outputs", ".kortix"]
network = ["api.github.com"]
human_approval = ["send_email", "delete_data", "charge_card"]
```

V0 should avoid over-configuring. The default is one Kortix agent, one runtime, one repo, one project brain.

## 4. CLI Behavior

### `kortix init <name>`

Creates a folder, initializes git, writes the starter files, and prints the next command.

It should not require a cloud account.

### `kortix start`

Runs inside a project folder.

It should:

1. find `kortix.toml`,
2. validate the project structure,
3. start local API,
4. start local dashboard,
5. start or connect to the local sandbox runtime,
6. load `.opencode` and `.kortix` config,
7. show the project in the dashboard.

If another local Kortix server is already running, `kortix start` should discover it and either attach to it or print the exact URL.

### `kortix deploy`

Deploys the current repo to Kortix Cloud.

It should:

1. require a clean git state or explicit `--dirty`,
2. detect the remote repo,
3. create or update the cloud Project,
4. upload/bind the repo ref,
5. validate required secrets and connectors,
6. build the runtime,
7. create the cloud Instance,
8. register triggers/channels/apps,
9. print the cloud dashboard URL.

Cloud deploy is a repo deployment, not a sandbox file upload.

## 5. API Shape

The API should be project-first and session-second.

```text
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/:projectId
PATCH  /v1/projects/:projectId

GET    /v1/projects/:projectId/config
POST   /v1/projects/:projectId/config/validate

GET    /v1/projects/:projectId/files?ref=main&path=.
GET    /v1/projects/:projectId/files/content?ref=main&path=.kortix/CONTEXT.md
POST   /v1/projects/:projectId/files/propose

GET    /v1/projects/:projectId/agents
GET    /v1/projects/:projectId/skills
GET    /v1/projects/:projectId/triggers
GET    /v1/projects/:projectId/connectors
GET    /v1/projects/:projectId/apps

POST   /v1/projects/:projectId/sessions
GET    /v1/sessions
GET    /v1/sessions/:sessionId
POST   /v1/sessions/:sessionId/messages
GET    /v1/sessions/:sessionId/events
GET    /v1/sessions/:sessionId/changes

POST   /v1/sessions/:sessionId/proposals
GET    /v1/proposals/:proposalId
POST   /v1/proposals/:proposalId/merge

GET    /v1/projects/:projectId/secrets
PUT    /v1/projects/:projectId/secrets/:key
DELETE /v1/projects/:projectId/secrets/:key

GET    /v1/projects/:projectId/connectors
POST   /v1/projects/:projectId/connectors/:type/connect
POST   /v1/projects/:projectId/connectors/:connectorId/test
```

Important rule: `GET /projects/:id/files` reads from the repo/ref, not from an arbitrary live sandbox.

Live sandbox file browsing can exist, but it should be explicitly session-scoped:

```text
GET /v1/sessions/:sessionId/files
```

That distinction keeps the UI honest.

## 6. Session Creation

`POST /v1/projects/:projectId/sessions`:

```json
{
  "title": "Investigate checkout bug",
  "agent": "kortix",
  "base_ref": "main",
  "mode": "ephemeral",
  "isolation": "branch",
  "prompt": "Find and fix the checkout bug."
}
```

Server behavior:

1. resolve the project repo and base ref,
2. create a branch/worktree name,
3. provision a sandbox,
4. clone or mount the repo,
5. load `.opencode` and `.kortix`,
6. inject scoped secrets/connectors without exposing all values,
7. start OpenCode with the `kortix` agent,
8. send the prompt,
9. stream events back to the central API.

Session modes:

- `ephemeral`: new sandbox per session, default for parallel work.
- `persistent`: reuses a named persistent project instance.
- `hybrid`: rehydrates project state into a new sandbox, then writes approved state back.

For V0, default to `ephemeral` for new sessions and keep `persistent` as an explicit setting.

## 7. Persistence Policy

Do not let every agent mutate the project brain directly.

Default:

- agents can edit their session sandbox freely,
- project source persists only through commit/PR/proposal,
- curated memory persists through a memory proposal,
- raw logs and transcripts persist in the operational DB,
- secrets never persist in git,
- external actions require connector scope and audit.

Persistent paths in `kortix.toml` are not automatic write permission. They are candidates for save/export.

V0 save flow:

```text
session sandbox diff
  -> proposal
  -> human review
  -> commit to repo or open PR
```

Later, trusted automations can auto-merge narrow changes.

## 8. UI Shape

Keep the UI simple. Users should not need to understand sandboxes first.

Main navigation:

- Chat
- Runs
- Files
- Skills
- Integrations
- Triggers
- Apps
- Settings

Default screen after `kortix start`:

- current project name,
- chat input,
- recent runs,
- health strip,
- quick buttons for connect integration, add trigger, edit context.

Files tab reads project repo files.

Runs tab shows sessions and their sandbox status.

Only inside a run should users see branch, worktree, diff, logs, and sandbox files.

Agent configuration can live under Settings or Files in V0. Do not make "agent team management" a primary product surface yet.

## 9. Current Suna Mapping

Keep these pieces:

- OpenCode as the first engine.
- `core/kortix-master/opencode/plugin/kortix-system` as the in-sandbox runtime layer.
- `sessions.ts` for session search, memory injection, and cross-session retrieval.
- `triggers` for cron/webhook/action dispatch.
- `credential-service.ts` for local encrypted credentials.
- `service-manager.ts` as the base for Apps.
- worktree plugin as the local branch/worktree primitive.
- existing web/mobile chat UI as the front door.

Change these pieces:

- `ProjectManager` should stop being the project source of truth.
- project files should come from repo refs, not from the current sandbox by default.
- old DB-only projects become compatibility rows.
- dashboard should become project-repo aware.
- sessions need central metadata synced from OpenCode/sandbox into API DB.
- worktree should become a first-class session isolation mode.
- credentials/connectors need user/agent/group scopes.
- team/role abstractions should be hidden from V0. The default surface is one Kortix agent with project-aware tools.

## 10. Implementation Slices

### Slice 1: Local Repo Project

- Add `kortix.toml` parser and validator.
- Add `kortix init` starter.
- Add `kortix start` that loads the current folder.
- Dashboard shows project config from local files.
- Files tab reads from local git checkout.

### Slice 2: Session From Repo

- `POST /projects/:id/sessions` creates a session from project repo state.
- Local implementation can use git worktree first.
- OpenCode runs in the worktree.
- Session events sync to API.

### Slice 3: Proposal Save

- Show session diff.
- Create proposal.
- Apply proposal as local commit or PR.
- Memory file updates use the same proposal path.

### Slice 4: Cloud Deploy

- Project row stores repo URL, default branch, manifest path.
- Deploy clones repo at SHA.
- Cloud instance runs the same runtime.
- Secrets/connectors bind from cloud control plane.

### Slice 5: Apps

- Compile `.kortix/apps.yaml` into `ServiceManager` registrations.
- Show apps in dashboard.
- Persist app definitions in git, runtime state in control plane.

## 11. Hard Opinions

- Start with one repo per project.
- Start with OpenCode as the only engine.
- Start with local git as the source of truth.
- Start with ephemeral isolated sessions by default.
- Make persistent project instance explicit.
- Do not put secret values in git.
- Do not read project files from random live sandbox state.
- Do not let parallel agents write to the same checkout.
- Make every durable change reviewable as a diff.
- Keep the dashboard simple enough to feel like a chat product.

## 12. Session Sandbox Architecture

Best implementation path:

```text
Project repo on main
  -> create session
  -> create branch kortix/session/<uuid>
  -> create isolated sandbox from runtime snapshot
  -> clone repo + checkout branch
  -> start OpenCode with .opencode/agent/kortix.md
  -> stream session events to API/UI
  -> collect diff + generated memory/config changes
  -> ask to contribute back
  -> commit/PR/proposal against main
```

Every session should have a stable binding:

```text
session_id
project_id
sandbox_provider
sandbox_id
repo_url
base_ref
branch_name
worktree_path
status
created_by_user_id or automation_id
```

Branch name format:

```text
kortix/session/<session_uuid>
```

Use branches, not shared mutable directories. The branch is the session's identity in git. The sandbox is the session's identity in compute.

### Local V0

For `kortix start`, do the simplest local thing first:

- run local API + dashboard,
- use the current repo checkout as the project source,
- on new session, create a local git worktree on `kortix/session/<uuid>`,
- start a new local Docker sandbox container from the runtime image,
- mount the worktree as `/workspace`,
- run OpenCode in that worktree,
- stream events back to the dashboard.

This proves the product loop without waiting on cloud provider complexity.

### Cloud V0

For `kortix deploy`, use the provider abstraction:

- build or choose a runtime snapshot image,
- create a sandbox from that snapshot,
- clone the project repo into `/workspace`,
- checkout `kortix/session/<uuid>`,
- inject scoped secrets/connectors,
- start OpenCode,
- stream back over the existing sandbox proxy/API channel.

Daytona is a good first cloud provider because it already matches this shape: create sandbox from snapshot, run process commands, operate on files, and clone/use git repos. But Daytona should be an adapter, not the product model.

The product model is:

```text
repo + branch + sandbox + session
```

Provider model:

```text
local_docker | daytona | justavps | future_microvm
```

### Snapshot Policy

The runtime snapshot should contain:

- Kortix Master,
- OpenCode,
- browser/computer tooling,
- baseline language runtimes,
- git,
- package managers,
- `/ephemeral/kortix-master`,
- startup scripts.

The project repo should not be baked into the snapshot. It is cloned/mounted per session.

Snapshots are for runtime speed and consistency. Git is for project truth.

### Contribute Back

The Kortix agent should always know:

- it is working in a session branch,
- the branch is disposable unless changes are proposed,
- durable changes go through `kortix proposal create` or equivalent API,
- repo files, `.kortix` memory, triggers, channels, apps, and `.opencode` config can all be proposed back,
- raw session logs stay operational state, not git state.

V0 does not need a perfect PR UI. It needs a reliable diff/proposal mechanism:

```text
GET  /v1/sessions/:sessionId/changes
POST /v1/sessions/:sessionId/proposals
POST /v1/proposals/:proposalId/apply
```

Local apply can commit directly to the repo. Cloud apply can open a GitHub PR.

## 13. Standalone POC Plan

Build this in a separate app first so the repo-native model can prove itself without fighting the existing Suna platform surfaces.

Recommended folder:

```text
apps/kortix-v0/
  package.json
  src/
    api.ts
    db.ts
    git.ts
    github.ts
    projects.ts
    sessions.ts
    providers/
      local-docker.ts
      daytona.ts
    ui/
```

This can be a Bun/Hono API with a minimal local UI. Do not start by wiring the full existing dashboard.

### POC Database

Use SQLite for the standalone POC.

```sql
projects (
  id text primary key,
  name text not null,
  repo_url text not null,
  default_branch text not null default 'main',
  manifest_path text not null default 'kortix.toml',
  created_at text not null,
  updated_at text not null
);

sessions (
  id text primary key,
  project_id text not null,
  branch_name text not null,
  base_ref text not null,
  sandbox_provider text not null,
  sandbox_id text,
  sandbox_url text,
  status text not null,
  created_at text not null,
  updated_at text not null
);

proposals (
  id text primary key,
  project_id text not null,
  session_id text not null,
  branch_name text not null,
  status text not null,
  diff_stat_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);
```

No sessions table row should exist without a branch. No branch should exist without a session row.

### Project Create

Support two modes:

```json
{
  "name": "Acme",
  "repo_url": "https://github.com/acme/kortix-acme.git"
}
```

and:

```json
{
  "name": "Acme",
  "github_owner": "acme",
  "repo_name": "kortix-acme",
  "private": true
}
```

Mode 1 imports an existing repo.

Mode 2 creates a GitHub repo using `GITHUB_TOKEN`, writes the starter project structure, commits it, and pushes `main`.

GitHub is the first implementation because it is the fastest source-of-truth path. The internal abstraction should still be plain Git so GitLab/self-hosted can come later.

### Project Read

`GET /projects/:id` should return metadata plus parsed project config.

`GET /projects/:id/files?ref=main&path=.` should read the git tree, not a sandbox.

Implementation should use a local bare mirror/cache:

```text
.kortix-v0/cache/repos/<project_id>.git
```

Read file trees through git:

```bash
git ls-tree -r --name-only <ref>
git show <ref>:<path>
```

This works for GitHub and any normal git remote. It also avoids depending on the GitHub contents API as the core file API.

### Session Create

`POST /projects/:id/sessions` should:

1. create `session_id`,
2. create branch `kortix/session/<session_id>` from `main`,
3. create sandbox from runtime image/snapshot,
4. clone repo inside sandbox,
5. checkout the session branch,
6. start OpenCode server in `/workspace`,
7. store the sandbox binding,
8. stream events to the UI.

The session branch name and session ID should match. That is what makes every run inspectable in Git.

### Runtime Snapshot Policy

Do not create a Daytona snapshot for every commit to `main`.

Use this rule:

```text
runtime snapshot = Kortix/OpenCode environment
project repo = cloned source of truth
session branch = working copy
```

Create or rebuild a provider snapshot only when the runtime layer changes:

- Kortix runtime version changes,
- OpenCode version changes,
- `Agent.Dockerfile` changes,
- dependency lockfiles change,
- explicit `kortix runtime build`.

For normal project config/content changes, just clone/pull latest `main` and branch from it.

### Inside vs Outside Sandbox

Inside the session sandbox:

- OpenCode server,
- shell/process execution,
- browser/computer tools,
- project worktree,
- temporary files.

Outside the session sandbox:

- project CRUD,
- GitHub repo creation/import,
- file tree reads from repo refs,
- triggers,
- channels,
- session routing,
- proposal/merge flow,
- secrets/connectors vault,
- billing,
- permissions,
- event ledger.

This is the long-term direction: the sandbox executes work; the control plane owns coordination.

The existing `kortix-master` can still be used initially as the in-sandbox runtime wrapper, but the target is to shrink the session sandbox down to the execution server plus required tools.
