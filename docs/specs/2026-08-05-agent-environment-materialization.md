# Agent Environment Materialization

- **Status:** Proposed
- **Date:** 2026-08-05
- **Related:** `docs/specs/2026-06-28-project-authorization-runtime-governance.md`, `docs/specs/2026-07-05-agent-first-config-unification.md`

## Decision

Kortix constructs each session environment on the API. The sandbox receives only
the selected agent's runtime files, permitted project files, declared data mounts,
and short-lived capabilities.

The sandbox still starts the selected harness. The sandbox does not discover or
compile project policy from a repository clone.

This design makes one rule enforceable:

> If a file enters a sandbox, assume the agent can read, copy, change, and disclose
> it. Do not deliver a file that the agent cannot access.

## Problem

Kortix already enforces secrets, connectors, and Kortix CLI permissions at the
API. These controls terminate at a trusted service.

Project files and harness configuration do not have the same boundary today:

- The sandbox receives a project clone by default.
- The clone contains every agent prompt, skill, tool, harness extension, grant,
  project memory file, and project file on the selected branch.
- The sandbox daemon resolves repository-local harness configuration after the
  clone.
- The manifest accepts `workspace: runtime|read|branch`, but no workspace
  materializer enforces those values.
- The Git proxy grants repository-level `read` or `write`. It does not grant
  path-level access.
- The server compiler emits the complete agent map. A compile failure can return
  no compiled configuration and still permit a legacy session boot.

Prompt instructions, harness permission globs, sparse checkout, and UNIX file
permissions do not solve this problem. The agent has a shell. A clone credential
can expose Git objects outside the visible working tree.

## Scope

The environment includes more than files:

- Selected harness and harness configuration.
- Agent prompt, skills, tools, and harness extensions.
- Project workspace files.
- Sandbox template, CPU, memory, disk, and runtime image.
- Secret and connector references.
- Kortix CLI capabilities.
- Network egress policy.
- Memory and volume mounts.

Environment variables remain encrypted in the Kortix data plane. This design
does not move configuration or secret values into volumes. Git remains the
authoring and review source for agent definitions. Volumes carry working data.

## Requirements resolved

| Concern                                                      | Decision                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Every sandbox receives the complete Git state                | Restricted modes receive a generated `WorkspaceArtifact`, not a clone.                               |
| Agent configuration is assembled inside the governed sandbox | The API compiles one signed `SessionSpec`; the sandbox only materializes and starts it.              |
| Harness and environment remain coupled                       | One normalized policy compiles through a harness adapter. The harness still runs inside the sandbox. |
| An agent needs no project repository                         | `runtime` mode delivers only generated runtime files.                                                |
| Agent switching can change file access                       | One agent is locked to one session. An access change creates a new sandbox.                          |
| Per-agent templates can create an unbounded template count   | Shared base images remain generic. Content-addressed artifacts carry per-agent state.                |
| Agents need different machine sizes                          | Each agent selects a permitted sandbox resource profile.                                             |
| Volumes and data need agent ownership and sharing            | Volumes are separate resources with explicit agent ACLs and mount modes.                             |
| Per-agent learning must coexist with shared project memory   | Memory has session, agent-private, project-shared, and reviewed classes.                             |
| Multiple harness configurations need clean organization      | Root configuration imports data-only agent definitions and harness-specific files.                   |
| Unpublished configuration can conflict with a session branch | `policy_sha` and `workspace_sha` are separate immutable references.                                  |
| An AGI coordinator needs to coordinate specialized agents          | Every child receives an independent environment and delegated capability intersection.               |

## Trust boundary

Treat the following components as trusted:

- Kortix API authorization.
- Agent environment compiler.
- Workspace materializer.
- Secret, connector, Git, patch, volume, and network brokers.
- Sandbox provider isolation.

Treat the following components as untrusted:

- Agent prompts and model output.
- Harnesses and harness extensions.
- Repository content.
- Shell commands and processes inside the sandbox.
- A sandbox user with administrative access inside that sandbox.

Every remote capability must terminate at a Kortix broker. A harness permission
is defense in depth. It is not the authorization boundary.

## Core objects

### AgentDefinition

`AgentDefinition` is the Git-authored request for an agent environment. It can
reference separate files to keep a large project manageable.

One root `kortix.yaml` remains the entry point. It can import data-only agent
definitions. Imports use repository-relative paths and deterministic merge rules.
The compiler rejects import cycles, duplicate agent identifiers, path escapes,
and excessive import depth or size.

Do not use executable TypeScript configuration for the first version. Executable
configuration introduces network access, non-deterministic output, dependency
installation, and compiler escape risks.

### SessionSpec

The API compiles one `SessionSpec` from:

- `project_id`, `session_id`, and selected `agent_id`.
- Launching human or service principal.
- Immutable policy and workspace Git SHAs.
- Agent definition and resource grants.
- Session-level narrowing.
- Platform policy and compiler versions.

The signed, content-addressed result contains:

- One selected agent and one harness adapter output.
- Workspace mode and workspace artifact digest.
- Sandbox resource profile.
- Permitted secret and connector identifiers.
- Kortix CLI actions.
- Network policy.
- Memory and volume mount declarations.
- Expiry, nonce, schema version, and content hash.

`SessionSpec` contains no secret values, connector credentials, or bearer tokens.

### WorkspaceArtifact

The workspace materializer reads project files at an exact SHA. It produces a
content-addressed artifact with permitted paths, file modes, and hashes.

The materializer excludes `.git` for restricted modes. It rejects absolute paths,
`..` traversal, escaping symbolic links, hard links, device files, case-folding
collisions, and Unicode-normalization collisions. Submodules and Git LFS objects
require explicit declarations and pinned revisions.

### SessionToken

The API issues a short-lived `SessionToken`. Its claims bind it to:

- `account_id`, `project_id`, `session_id`, `sandbox_id`, and `agent_id`.
- `SessionSpec` hash and policy revision.
- Allowed broker audiences and actions.
- Expiry and nonce.

Every broker checks the token and current resource authorization. Copying the
token to another sandbox or project must fail.

## Workspace modes

| Mode      | Files in sandbox                                     | Git credential | Use                                                           |
| --------- | ---------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| `runtime` | Generated agent and harness files only               | No             | Connector work, reports, support, orchestration               |
| `read`    | Read-only artifact containing selected project paths | No             | Analysis and document processing                              |
| `patch`   | Writable artifact containing selected project paths  | No             | Restricted code and content changes                           |
| `branch`  | Full project checkout                                | Yes            | Explicitly trusted engineering and project-maintenance agents |

`runtime` becomes the default for new agents. Existing projects can retain a
documented legacy full-clone mode during migration.

Standard Git cannot provide confidential path-level access. Sparse checkout only
changes the working tree. Reachable commits, trees, and blobs can still expose
excluded content. Therefore `read` and `patch` never receive a Git credential.

In `patch` mode, the agent submits a patch to the Kortix patch broker. The broker
validates every create, update, delete, and rename against the allowed path set.
It then applies the complete patch atomically to a change-request branch.

`branch` means full repository read access. The Git proxy still restricts allowed
refs, pushes, force pushes, tags, and protected branches. The product must label
this mode as high trust.

## Session creation flow

1. The API resolves the launching human or service principal.
2. The API locks one agent to the session.
3. The API resolves `policy_sha` and `workspace_sha` once.
4. The compiler loads only the selected agent and its declared dependencies.
5. Authorization intersects the principal, project role, agent grant, session
   narrowing, trigger delegation, and live resource grants. Denials win.
6. The materializer creates the exact `WorkspaceArtifact` for the workspace mode.
7. The API creates and signs `SessionSpec`.
8. The API provisions a shared base sandbox with the selected resource profile.
9. The sandbox verifies the signature and artifact hashes before readiness.
10. The sandbox writes the selected harness files and starts the harness.
11. The agent uses brokers for secrets, connectors, Kortix CLI, Git, patches, and
    controlled network access.
12. Session termination revokes tokens, unmounts data, and destroys writable
    runtime state.

This flow supports OpenCode, Codex, Claude Code, Pi, and future harnesses. The
compiler produces one normalized policy. A harness adapter produces the harness
files. The harness remains inside the sandbox.

## Configuration and unpublished changes

Use separate immutable references:

- `policy_sha` selects reviewed agent policy and harness configuration.
- `workspace_sha` selects project files for the session branch.

An agent can propose a policy change through a change request. The change does
not alter its running session. Previewing unreviewed policy requires a separate
human permission and an explicit session option. Scheduled and webhook sessions
must use reviewed policy.

A behavior-only update, such as a prompt or model change, can produce a new
signed `SessionSpec` generation and reload at an idle boundary. Any change to
files, credentials, network, volumes, or capabilities creates a new sandbox.
Removing access cannot make an existing sandbox forget bytes it already received.

Agent switching follows the same rule. The safe default is a new session and a
new sandbox. The previous transcript is not copied automatically because it can
contain data that the next agent cannot access.

## Per-agent resources

### Sandbox profile and startup latency

Each `AgentDefinition` selects a permitted sandbox profile. The API applies the
project and account ceilings before provisioning.

Do not create one immutable sandbox image per agent. That produces stale images
and an unbounded template count. Use shared base images and content-addressed
`SessionSpec` and `WorkspaceArtifact` delivery. Warm pools can be keyed by base
image and sandbox profile. They must contain no project data.

`runtime` agents can use smaller profiles because they do not clone or initialize
a project repository.

### Volumes

A volume is an independently authorized resource. Its declaration defines owner,
allowed agents, mount path, read or write access, quota, encryption, retention,
and cross-session sharing.

A shared volume is an explicit data-sharing edge between agents. It must never
carry agent policy or the core harness configuration.

### Memory

Memory uses explicit resource classes:

- Session scratch memory.
- Agent-private memory.
- Project-shared memory.
- Reviewed, published project memory.

An agent receives only declared memory resources. Per-agent learning does not
require a separate repository. Agent-private and shared memory can coexist in one
project when materialization and access are explicit.

### AGI agent and child sessions

An AGI coordinator orchestrates child sessions through the Kortix CLI. Each child gets
its own sandbox, `SessionSpec`, `WorkspaceArtifact`, and `SessionToken`.

Child access is the intersection of the parent's delegatable access and the child
agent's grants. The parent transfers inputs through explicit artifacts. A shared
full repository or volume is not the default delegation mechanism.

## Edge cases

| Case                                           | Required behavior                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Branch moves during compilation                | Resolve once and compile from the resulting SHA.                                                                          |
| Branch is deleted or force-pushed              | Running artifacts remain immutable. New compilation fails if source objects are unavailable.                              |
| Agent edits its policy                         | Current authority does not change. Activation requires reviewed policy or explicit preview permission.                    |
| Config import is missing, cyclic, or ambiguous | Compilation fails closed with a precise error.                                                                            |
| Server compilation fails                       | Restricted session creation fails. It never falls back to full clone or unrestricted config.                              |
| Harness adapter version differs                | Sandbox rejects unsupported `SessionSpec` versions.                                                                       |
| Symbolic link escapes an allowed path          | Materializer rejects the artifact.                                                                                        |
| Rename crosses the allowed path boundary       | Patch broker validates source and destination, then rejects the patch.                                                    |
| Submodule or LFS file is selected              | Compiler resolves the explicitly pinned object. The sandbox receives no extra credential.                                 |
| Agent requests Git in `read` or `patch`        | Request is rejected. These modes have no Git credential.                                                                  |
| Agent changes during a session                 | Start a new session and sandbox. Do not reuse the transcript by default.                                                  |
| Access is revoked                              | Brokers reject new calls immediately. Terminate and rebuild to remove local files or runtime secrets.                     |
| Runtime secret is required                     | Mark it as high risk. Never record its value. Destroy the sandbox after revocation.                                       |
| Secret appears in logs or crashes              | Redact before transport and storage. Treat agent output as potentially sensitive.                                         |
| Network destination redirects                  | Revalidate every destination. Block loopback, private networks, metadata services, and DNS rebinding.                     |
| Harness extension executes code                | Treat it as code execution. Require a pinned artifact and explicit grant.                                                 |
| Shared volume contains restricted data         | Volume ACLs and mount declarations must authorize every receiving agent.                                                  |
| Warm sandbox is reused                         | Remove processes, writable layers, caches, mounts, credentials, and network sessions before use. New sandboxes are safer. |
| Session token is copied or replayed            | Audience, sandbox, session, agent, hash, expiry, and nonce checks reject it.                                              |
| Scheduled or webhook session starts            | Use a service principal and explicit trigger delegation. Never select an account owner implicitly.                        |
| Concurrent sessions use one agent              | Give each session independent artifacts, tokens, scratch storage, and audit records.                                      |
| Artifact is too large                          | Enforce path count, byte, compression-ratio, and compilation-time limits.                                                 |
| Project is archived during a session           | Revoke brokers and terminate the runtime under project retention policy.                                                  |

## Audit and explainability

Store the `SessionSpec`, source SHAs, compiler version, artifact hashes, principal,
selected agent, effective resource identifiers, token lifecycle, broker decisions,
denials, sandbox verification, and termination reason.

Do not store secret values, bearer tokens, or decrypted connector credentials.
Record their version identifiers instead.

The product must explain why each file or resource is present or absent. The
session UI and CLI should show requested access, effective access, denied access,
workspace mode, policy SHA, workspace SHA, and `SessionSpec` hash.

## Implementation sequence

1. Define and version `SessionSpec`, compiler inputs, and authorization decisions.
2. Lock one agent to one session. Compile only that agent. Fail closed for
   restricted projects.
3. Bind sandbox and broker tokens to the selected agent and `SessionSpec` hash.
4. Implement `runtime` mode without a repository clone or upstream Git credential.
5. Implement `read` with a validated, read-only `WorkspaceArtifact`.
6. Implement `patch` with server-side path validation and change-request output.
7. Define `branch` as explicit full-repository access and restrict Git refs and
   write operations.
8. Add per-agent sandbox profiles, volumes, memory, and network policy.
9. Add environment preview, decision explanations, and complete audit events.
10. Migrate existing projects explicitly. Make `runtime` the new-agent default.

## Verification gates

- Compiler output is deterministic for identical inputs.
- One agent's artifact contains no other agent prompt, skill, tool, or memory.
- `runtime` starts with no project files, `.git`, or Git credential.
- `read` cannot recover excluded files through Git objects, links, archives, or
  alternate paths.
- `patch` rejects denied creates, updates, deletes, and renames atomically.
- `branch` exposes the full-read warning and rejects unauthorized refs and pushes.
- A forged or replayed token fails every broker.
- A revoked grant blocks the next broker call.
- A policy change cannot expand a running session.
- Agent switching creates a clean sandbox and does not copy restricted context.
- Warm-pool reuse exposes no prior process, file, mount, cache, or credential.
- Audit records reconstruct the effective environment without storing secrets.

## Result

Git remains the reviewable source for agent definitions. The Kortix API becomes
the compiler and policy boundary. The sandbox becomes a disposable target that
receives one exact environment. Harness choice, sandbox size, project files,
memory, volumes, and remote resources become explicit per-agent decisions.
