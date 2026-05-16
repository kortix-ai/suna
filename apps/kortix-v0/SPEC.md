# Kortix V0 Spec

Kortix V0 proves the new product spine before the legacy instance/VPS system is refactored.

## Product Thesis

A Kortix project is a Git repository plus cloud control-plane metadata. The Git repo can be user-provided or managed by the Kortix control plane. In the v0 POC, managed repos are private GitHub repos so remote sandboxes can clone them. A session is a disposable sandbox running OpenCode against one branch of that repository.

The repo is the durable source of truth. The sandbox is runtime only.

## Core Objects

### Project

Stored in the control-plane DB.

- `id`
- `name`
- `repo_url`
- `default_branch`
- `manifest_path`
- timestamps

The default repo contains only the minimal OpenCode runtime config:

```txt
kortix.toml
.opencode/opencode.jsonc
.gitignore
README.md
```

Optional project-owned runtime config can be added later:

```txt
.opencode/agents/*
.opencode/skills/**
random durable files
```

### Vault Secret

Stored in the control-plane DB, encrypted at rest.

- `project_id`
- `key`
- encrypted value
- timestamps

Secret values are never committed to Git. The repo only declares required and optional keys.

### Session

Stored in the control-plane DB.

- `id`
- `project_id`
- `agent_name`
- `branch_name`
- `base_ref`
- `sandbox_provider`
- `sandbox_id`
- `sandbox_url`
- `opencode_session_id`
- `status`
- timestamps

Each session is one sandbox plus one Git branch.

## Repo Contract

`kortix.toml` is the human-readable contract.

```toml
schema = "https://schemas.kortix.com/project/v0"
name = "Acme AI Company"

[runtime]
engine = "opencode"
mode = "ephemeral"
workspace = "/workspace"

[source]
default_branch = "main"

[opencode]
config_dir = ".opencode"
config = ".opencode/opencode.jsonc"

[env]
required = []
optional = []
```

The control plane parses:

- OpenCode config
- optional agents
- optional skills
- env requirements
- runtime config location
- future triggers/channels/policies

## Sandbox Contract

The sandbox should eventually run only:

```bash
kortix-runtime serve
```

Runtime responsibilities:

1. Clone project repo.
2. Checkout session branch.
3. Resolve `.opencode`.
4. Merge baked defaults with project config.
5. Start `opencode serve`.
6. Expose health and session APIs.

Not sandbox responsibilities:

- org/user/group permissions
- secrets storage
- trigger scheduling
- channel listeners
- billing
- audit logs
- project CRUD

Those live in the cloud control plane.

## Session Flow

1. User selects project.
2. User enters a prompt and optionally selects a custom agent if the repo defines one.
3. API creates `Session`.
4. API starts Daytona sandbox with env vars:
   - repo URL
   - branch name
   - session ID
   - scoped vault secrets
5. Runtime clones repo and starts OpenCode.
6. API creates an OpenCode session.
7. UI streams/reloads messages.
8. Session changes can later become a PR/proposal.

## V0 Acceptance

V0 is real when this works end to end:

- Create/import project from any readable Git repo.
- Create a managed Git project when the user does not bring a repo.
- Detect whether repo is Kortix-shaped.
- Show repo files.
- Show optional agents and skills when present.
- Parse required/optional env keys from `kortix.toml`.
- Store project secrets in encrypted DB.
- Show missing/set env status.
- Start a Daytona session with OpenCode default behavior unless a custom agent is selected.
- Open live OpenCode URL.
- Send messages to that session.
- Stop an active run.

PR/proposal back to `main` is next, after this spine is stable.
