# Project Authorization And Runtime Governance

Status: working document
Date: 2026-06-28
Owner: Kortix product/infra
Related: `docs/specs/2026-06-28-token-session-agent-identity.md`

## Purpose

Define the target authorization model for projects, agents, skills, connectors,
secrets, config, and sandbox runtime construction.

This exists because three product threads are now the same security problem:

1. Users and groups need project-level roles and resource access.
2. Agents need session-bound identity and immutable grants.
3. Sandboxes must stop exposing the whole repo/runtime surface to every agent by
   default.

The token/session/agent identity work is the prerequisite. It makes the runtime
principal explicit: a sandbox session has a `KORTIX_EXECUTOR_TOKEN` bound to one
project, one session, and one boot agent grant. This document defines what that
grant should eventually control.

## Raw Prompt Input

These raw inputs are kept here deliberately so the working document preserves the
original product/security framing, not only the cleaned-up model.

```text
https://kortix.com/accounts/2e3ad9d3-6381-4a64-8d72-33b7c9a9d365 Okay, next problem. We have both an account like users basically get permissions from the from an account and then there's account level permissions and project level permissions essentially we only ever really care about the project level permissions if we're for real and the creation of groups we actually don't really care about on a account level, but we do care about on a project level and also the qu the whole question of roles right like there's some default roles we the question is what what models to adapt like what like how you can do this whole authorization but what we need at the end of the day is i mean we have a project right in that project people should have access to one different customize settings but also to different resources like you know whether they can like by default which groups or like which users can access which agents and skills you know like by default it's all always public actually this means changing the way the runtime model works because right now we just git clone everything into the sandbox and that eliminates that by default shares everything with everyone which is non-optimal perhaps we should switch to a true like single source of truth Kortix.toml model where the tummel where it basically will build the sandbox or the the full config and everything from whatever we get in the tumml and then in the tomal we can have a like a like git clone like config or like allow self-improvement or self-config or whatever where it's actually actively able to edit and change its own config and even has access to git like all of these policies and permissions like we have cli access like general Kortix cli blah blah like in Kortix.toml but it's all a bit ugly right and we have shit like this which we have to consider so we can we yeah on a project level right now everything is shared by everyone one we have to just make sure okay certain groups can't change anything in the customize they can't change you know they can't new add connectors they can't do this they can't do that like they don't have any git permission like all the permissions like policies that we have on like a per pro project level needs to be managed right we need to have roles for that which give you which give you the role and the pro like in a project right and then we can have groups for instance like if we want to say finance department that just by default and actually i don't know like this is the weird thing like does the group inherit the role no roles are always user based there's one minimal role but then there's so there's one permissions and then there was resource access management because in the second thing or like in the first thing i was saying it's like what access to which agents and skills does this user have right now everything is exposed to everyone so in the future we will need to change this or right now we will need to change this or think of a way how we can change it and that would maybe mean that Kortix.toml just becomes a single source of truth that we build from you know like we don't do the regular git clone anymore where we just git clone by default but that's just like if self-improvement is enabled so that the Kortix system can actually load and then we also the open code we construct a bit differently we will only like clone the or like take the things that are enabled for that given agent of a given session and then even that we could scope better because we could make sure that every session always explicitly has to be started with one agent and that you can't change the agent midway through and that way we would have maximum isolation and security on a per agent like yeah I don't you can challenge if I have any gaps in my mental understanding but this would at least make it significantly more secure of running the agents and even only certain agents are capable of self-improvement then and like even looking into their own config and we just basically always parse the single source of truth being the Kortix Automil and that depends then on like does it can it do it or can it not you know kortix.toml & .kortix perhaps.

---

──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• 1. What changed
     Fixed and pushed c21209bf to origin/main and origin/executor-session-identity.

     Root cause: warm-pool session claims minted project-scoped tokens without sessionId / agentGrant, while cold boots minted proper session
     executor tokens. That made Executor connector lookup resolve as unassigned/empty.

     Main fixes:
      - Warm-pool claims now mint session-bound executor tokens with project, session, agent, connector, and kortix_cli grant context.
      - Auth middleware now exposes sessionId for PAT/account-token auth.
      - Executor principal resolution now uses token session context, not only X-Kortix-Session-Id.
      - /accounts/me and kortix whoami/token now show explicit token_context.
      - Added kortix token as a real alias instead of accidentally scaffolding token/.
      - Blocked in-session prompt agent switches with 409 AGENT_SWITCH_REQUIRES_NEW_SESSION.
      - Added the spec: docs/specs/2026-06-28-token-session-agent-identity.md.

  2. What was verified
     Local checks passed:
      - API preview proxy tests.
      - warm-pool / agent-grant / unit scope tests.
      - executor SDK tests.
      - CLI host/auth tests.
      - API and CLI TypeScript checks.
      - git diff --check.

     Live local E2E passed:
      - Real API stack.
      - Minted real session executor token for veyris.
      - /v1/accounts/me.token_context returned correct project/session/agent grants.
      - Executor catalog returned 200.
      - kortix token --json and human output showed session token context.
      - Confirmed no accidental token/ scaffold directory.

     Remote verified:
      - origin/main and origin/executor-session-identity both point to c21209bfdd02c78451f64145188d1dbae679e823.
      - CodeQL passed.
      - Deploy Dev initially hit Docker Hub timeout in Tag API dev-<sha8>, I reran failed jobs, and Deploy Dev is now green.
      - https://dev-api.kortix.com/v1/health reports version: 0.9.83-dev.c21209bf, commit c21209bfdd02c78451f64145188d1dbae679e823.

  3. What remains unverified or risky
     No known code-path gap remains from the original bug. The only caveat is product behavior: explicit agent switching inside an existing
     sandbox now returns 409; that is intentional for security, but any UI that expected silent switching must start a new session instead.

  4. What you should test next
     In dev, start a fresh Veyris session that has connectors = "all", then inside the sandbox run:
      - kortix token
      - kortix whoami --json
      - the Executor connector/catalog call that previously returned empty or connector_not_assigned

     Expected result: it should identify as a session token with the correct project/session/agent context, and Executor should see the
     configured Veyris connector grants.

─ Worked for 36m 18s ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────


› Okay, so sh so now should ev everything should work, yeah?


• Yes, for the bug we traced: fresh dev sessions should now get a session-scoped executor token, so Executor connector discovery should no
  longer be empty just because the sandbox came from the warm pool.

  The fix is live on dev: dev-api.kortix.com reports commit c21209bf. The thing to verify manually is the exact Veyris flow: start a new
  session, run kortix token / kortix whoami --json, and then call the executor connector path. It should show session token context with
  project/session/agent grants and find the configured tools.

  One intentional behavior change: switching agents inside the same existing sandbox should now fail with 409 and require a new session.
  That’s expected. / Also, this is something in this regard that I just pushed to main that is also like of same concern, right? yeah, let's create one big spec list of things like create a working document here that stores documentation around this so we can agree like we can plan this out.
---

You also in the document just keep all my raw messages from this thread that I had in there? Like just the raw thing that I said and went like f the full block so my raw prompt is in.

---

Yeah, just add all my prompts in there, just keep doing that. So like that the markdown just keeps the keeps the actual thing.

---

Also self-improve, by the way, here is a bit of a weird one. I just mean like self-improve by like git clone and then self improve just means that like oh it can use a CR, like a change request and open a new bra like open change request etc. That's like also like self improve is the wrong thing, like I wouldn't name it that. I'm just generalizing into that term.

---

114
    115 +### Ongoing raw-input capture instruction
    116 +
    117 +```text
    118 +Yeah, just add all my prompts in there, just keep doing that. So like that the markdown just keeps the keeps the actual thing.
    119 +``` Just put it all in one like category called raw like prompt input.

---

We should push this to origin to main.
```

## Current State

### IAM shape

Current IAM V2 is intentionally simple:

- Account roles: `owner`, `admin`, `member`.
- Project roles: `manager`, `editor`, `viewer`.
- Groups are account-scoped membership containers.
- A group can grant a project role through `project_group_grants`.
- Effective project role is the max of direct project membership, group grants,
  and account owner/admin implicit project manager.

This is the right base. Do not reintroduce DB-defined custom role grammar until
there is a strong product reason.

### Agent grant shape

`kortix.toml` already has a first project-agent governance surface:

```toml
[[agents]]
name = "veyris"
connectors = "all"
kortix_cli = ["project.read", "project.cr.open"]
```

When a project adopts `[[agents]]`, listed agents receive connector and
Kortix-CLI grants, while unlisted agents become default-deny. The effective
permission is intended to be:

```text
human project role AND session agent grant AND resource grant
```

### Runtime shape

The sandbox daemon still materializes a repo checkout and points OpenCode at the
project config dir. That means any agent that can run inside that sandbox can
potentially inspect repo-backed agents, skills, commands, tools, memory, config,
and source files unless the runtime is constructed differently.

The new session token identity fix closes the connector-token identity hole. It
does not by itself solve runtime surface exposure.

## Product Decision

Treat account-level permissions as account administration only. The product
surface users care about is project-level:

- Who can see the project.
- Who can start sessions.
- Who can manage Customize sections.
- Who can use which agents.
- Which agents can use which skills, tools, connectors, secrets, channels, and
  git/config powers.

Groups should not become a separate authorization language. Groups group people.
Roles grant coarse project capabilities. Resource ACLs grant access to concrete
project resources.

## Target Model

### 1. Roles stay coarse

Keep fixed project roles:

| Role | Product meaning |
| --- | --- |
| `viewer` | Can view project, sessions, outputs, and allowed resources. Cannot start privileged work unless explicitly allowed later. |
| `editor` | Can start sessions, run allowed agents, edit normal project content, and manage non-sensitive Customize sections. |
| `manager` | Can manage members, groups, sensitive settings, gateway keys, dangerous runtime powers, and resource ACLs. |

The exact permission matrix can change, but the shape should remain fixed roles,
not per-account custom roles.

### 2. Resource ACLs are separate

Introduce a resource access layer for project resources.

Resources:

- `agent`
- `skill`
- `command`
- `tool`
- `connector`
- `secret`
- `channel`
- `schedule`
- `webhook`
- `app`
- `memory`
- `file`
- `config`
- `sandbox_template`
- `model_profile`

Principals:

- `project`: everyone with project access.
- `group`: account group.
- `user`: individual user.
- `agent`: another agent or runtime identity, only where it makes sense.

Actions:

- `view`: list/read metadata.
- `use`: invoke, load, or inject into a runtime.
- `edit`: change the resource definition.
- `manage`: change sharing, credentials, policies, or dangerous settings.

Default:

- Existing projects stay permissive: resources are `project/use` unless
  explicitly restricted.
- New restricted resources can opt into ACLs immediately.
- A future project setting can switch the default to private-by-default.

### 3. Sessions are agent-immutable

A project session starts with exactly one boot agent.

The selected boot agent determines:

- session executor token `agent_grant`
- visible agent persona
- visible skill set
- visible commands/tools
- connector catalog
- secret injection
- git/config capabilities
- allowed runtime files

Changing agents mid-session requires a new session. The 409
`AGENT_SWITCH_REQUIRES_NEW_SESSION` behavior is the correct secure default.

### 4. Runtime is generated from policy

OpenCode-native files can remain the authoring format, but they should not be
the direct runtime surface for every session.

At session birth, the control plane should build an effective runtime bundle:

```text
kortix.toml
  + project resource ACLs
  + selected boot agent
  + launching user role/groups
  + session token agentGrant
  + server-side connector/secret policy
  -> generated OpenCode config dir
  -> scoped executor token
  -> scoped runtime env
  -> scoped workspace
```

For compatibility, this generated config can still look like native OpenCode:

- `agents/<selected-agent>.md`
- only allowed `skills/*`
- only allowed commands/tools/plugins
- generated `opencode.jsonc`
- generated executor/gateway provider config

The key change is ownership: OpenCode reads generated runtime material, while
Kortix decides what may be generated.

### 5. Full repo access is an explicit power

Do not clone the full project repo into every business-agent session by default.

Add explicit agent runtime capabilities:

| Capability | Meaning |
| --- | --- |
| `workspace = "runtime"` | Generated runtime files only. No full repo checkout. |
| `workspace = "read"` | Read-only project snapshot mounted or materialized. |
| `workspace = "branch"` | Full session branch checkout, no base-branch write. |
| `git = "none"` | No git binary credentials. |
| `git = "read"` | Can inspect history, no push. |
| `git = "cr"` | Can commit to session branch and open CR. |
| `git = "write"` | Can push/merge when also allowed by human role and agent grant. |

Most domain agents should run in `workspace = "runtime"` or
`workspace = "read"`. Only builder/reflection/admin agents should get
branch checkout plus change-request powers.

Do not name this capability `self_improve` in the product or API. In this
thread, "self-improve" was shorthand for "the agent can work on a real repo
branch and open a change request against the project." The capability should be
named around the actual authority:

- `workspace = "branch"`
- `git = "cr"`
- `change_requests = ["open"]`

If we later need a higher-risk capability for direct config mutation or merge,
name it explicitly (`config_write`, `change_requests.merge`, etc.) instead of
using a vague umbrella term.

## Proposed Manifest Shape

This is illustrative, not final syntax.

```toml
[[agents]]
name = "veyris"
connectors = ["linear", "gmail"]
kortix_cli = ["project.read", "project.session.read"]
skills = ["financial-analysis", "report-writer"]
commands = []
workspace = "runtime"
git = "none"

[[agents]]
name = "builder"
connectors = "all"
kortix_cli = ["project.read", "project.write", "project.cr.open"]
skills = "all"
workspace = "branch"
git = "cr"
change_requests = ["open"]

[[resources]]
type = "agent"
name = "veyris"
default = "project"

  [[resources.grants]]
  principal = "group:finance"
  actions = ["view", "use"]

[[resources]]
type = "skill"
name = "financial-analysis"
default = "restricted"

  [[resources.grants]]
  principal = "agent:veyris"
  actions = ["use"]

  [[resources.grants]]
  principal = "group:finance"
  actions = ["view"]
```

Open question: resource ACLs may be better stored as DB state with TOML as the
declarative/default source. See "Source of truth split".

## Source Of Truth Split

Use this rule:

| Concern | Source of truth |
| --- | --- |
| Resource definitions | `kortix.toml` and `.kortix/*` |
| Default project policy | `kortix.toml` |
| Installed skills/tools/agents | Git repo |
| User membership | DB |
| Group membership/SCIM sync | DB |
| Emergency grants/revokes | DB |
| Credential ownership and sharing | DB |
| Audit events | DB |
| Effective runtime bundle | Generated from Git + DB at session birth |

This keeps projects portable while allowing immediate revocation and enterprise
admin flows without requiring a commit for every membership change.

## Implementation Plan

### Phase 0 - Stabilize identity

Done or in progress:

- Session executor tokens include `project_id`, `session_id`, and `agent_grant`.
- Warm-pool claim and cold boot mint the same token shape.
- `/accounts/me` exposes `token_context`.
- CLI identity probes show session token context.
- Agent switching inside a running session returns 409.

Required follow-up:

- Make UI agent switching create a new session instead of trying to mutate the
  current one.
- Add explicit UX copy for "different agent = new isolated session".

### Phase 1 - Permission vocabulary

Add project actions for Customize/resource management:

- `project.agents.read`
- `project.agents.manage`
- `project.skills.read`
- `project.skills.manage`
- `project.commands.manage`
- `project.connectors.read`
- `project.connectors.manage`
- `project.secrets.read`
- `project.secrets.manage`
- `project.channels.manage`
- `project.schedules.manage`
- `project.webhooks.manage`
- `project.files.read`
- `project.files.write`
- `project.config.read`
- `project.config.write`
- `project.runtime.manage`

Map these to fixed roles first. Do not build custom roles yet.

### Phase 2 - Resource ACL API

Add a normalized resource ACL model.

Candidate tables:

- `project_resources`
- `project_resource_grants`
- `project_resource_effective_cache` only if needed for performance

Candidate API:

- `GET /v1/projects/:id/resources`
- `GET /v1/projects/:id/resources/:type/:name/grants`
- `PUT /v1/projects/:id/resources/:type/:name/grants`
- `POST /v1/projects/:id/resources/evaluate`

Evaluation returns:

```json
{
  "resource": { "type": "agent", "name": "veyris" },
  "principal": { "user_id": "...", "group_ids": ["..."] },
  "actions": { "view": true, "use": true, "edit": false, "manage": false },
  "sources": ["project_default", "group:finance"]
}
```

### Phase 3 - Product gating

Gate the real product surfaces:

- Project home agent picker.
- Session composer agent picker.
- Customize sections.
- Marketplace install/update/remove.
- Connector connect/sharing/policy actions.
- Secret create/read/update/delete.
- Trigger/channel/schedule management.
- Project files/config editor.

Rules:

- Hide resources the user cannot view.
- Disable actions the user cannot perform.
- Server must enforce every hidden/disabled control.

### Phase 4 - Agent runtime bundle

Add a server-side runtime compiler.

Input:

- project id
- session id
- selected agent
- launching user id
- account id
- project manifest commit/base ref

Output:

- effective runtime manifest
- generated OpenCode config files
- executor connector allow-list
- secret/env allow-list
- workspace mode
- git credential mode
- token claims/grants

This compiler should be deterministic and testable without a sandbox.

### Phase 5 - Sandbox materialization

Change sandbox boot from "clone everything and point OpenCode at repo config" to
"materialize the effective runtime bundle".

Compatibility path:

- Legacy projects with no `[[agents]]` can keep full clone behavior.
- Adopted projects use generated runtime.
- Self-improvement agents can opt into full branch checkout.

The daemon should expose health/debug state:

- boot agent
- session id
- token context
- runtime bundle hash
- workspace mode
- generated config dir
- allowed connectors count
- allowed skills count

### Phase 6 - Audit and explainability

Every access decision should be explainable:

- why a user can use an agent
- why an agent can use a connector
- why a skill was included or excluded
- why a session has or does not have git credentials
- which policy/source granted access

Add audit events for:

- resource grant changes
- session runtime bundle creation
- denied agent switch
- denied connector use
- denied secret injection
- change-request creation from an agent session

## Security Invariants

1. A session token is bound to one session and one boot agent.
2. A session cannot switch agents without a new token/runtime bundle.
3. An agent cannot exceed the launching user's project role.
4. An agent cannot use a connector unless both user and agent grants allow it.
5. Secrets are injected only when user, agent, resource ACL, and credential
   sharing allow it.
6. Full repo clone is not the default runtime for restricted projects.
7. Repo-branch/change-request authority is explicit and produces a CR, not
   silent base-branch writes.
8. DB revocation must affect new calls immediately or within a documented short
   cache TTL.
9. UI hiding is never the enforcement boundary.
10. Generated runtime bundles are reproducible from audited inputs.

## Open Questions

1. Should resource ACLs be committed to `kortix.toml`, stored only in DB, or
   stored in DB with TOML defaults?
2. Do project viewers get `project.session.start`, or is starting an agent an
   editor-level action by default?
3. Should "use agent" and "view agent definition" be separate by default?
4. Do skills need user-visible ACLs, or are they only agent-scoped resources?
5. How private should `.kortix/memory` be by default?
6. Should an agent be able to reference another agent as a resource?
7. Can a session upgrade from generated runtime to full checkout, or must that
   always start a new session?
8. How do scheduled/channel-triggered sessions choose a user principal when no
   human is actively launching the session?
9. What is the migration path for existing projects that rely on full repo
   access in every agent?
10. Which permissions should be enforced by OpenCode config generation versus
   by the Executor/API on every call?

## Verification Gates

Before this is considered implemented:

1. User A in group `finance` can see and use `veyris`; User B cannot.
2. User B cannot start `veyris` through web, API, CLI, Slack, or trigger paths.
3. A `veyris` session sees only allowed connectors in Executor catalog.
4. A `veyris` session cannot call a blocked connector even by raw API request.
5. A `veyris` session cannot load a restricted skill file from the generated
   config dir.
6. A normal business-agent session has no git push credential.
7. A branch-authorized agent can edit config only on a session branch and open
   a CR.
8. Trying to switch agents inside a running session returns 409 and does not
   mutate token context.
9. Revoking a group grant prevents new sessions and new connector calls.
10. `/accounts/me`, `kortix token`, and sandbox health all report matching
   project/session/agent context.

## Near-Term Checklist

- [ ] Land UI behavior for 409 agent switch: create a new session.
- [ ] Add a project Customize permission matrix.
- [ ] Decide DB versus TOML storage for resource ACLs.
- [ ] Add resource grant schema and evaluator.
- [ ] Gate agent listing/use in API before changing sandbox materialization.
- [ ] Build deterministic runtime bundle compiler.
- [ ] Add generated OpenCode config smoke tests.
- [ ] Add sandbox boot mode for generated runtime.
- [ ] Migrate one real project/agent as the pilot.
- [ ] Add black-box E2E across web, API, CLI, and sandbox Executor.
