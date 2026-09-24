# Agents as principals

Status: in progress, branch `agent-principals`. Owner: Marko. Date: 2026-09-22.

## 1. Problem

An agent session authorizes as the HUMAN who launched it. Its power is the
launcher's project role intersected with the agent's `kortix_cli` list
(`iam/actor.ts:124`, `iam/authorize.ts:213-252`). Consequences, all verified on
`origin/main` `33ace734d4`:

1. The same agent can do different things depending on who clicked.
2. Unattended runs (trigger fire, email, Telegram, Slack without a linked user)
   authorize as the ACCOUNT OWNER (`projects/lib/triggers.ts:971`,
   `session-lifecycle/actor.ts:7`). A project `member` can fire a trigger
   (`project.trigger.fire`) and get owner ∩ grant (V2).
3. An agent cannot be named on a resource. A restricted App cannot say "these
   people plus agent X" (`apps/access.ts:95`). The App gate evaluates the
   launcher, never the agent (`apps/access.ts:258`).
4. `kortix_cli` is a misnomer. It is exactly the 45 `project.*` catalog
   permissions (`GRANTABLE_KORTIX_CLI_ACTIONS`), i.e. a project role written in
   git. It has nothing to do with the CLI.
5. The existing "standing identity" path (an admin binds a role to the agent's
   service account → the session authorizes as the SA) is hidden and broken for
   system roles: an SA gets authority from CUSTOM roles only, so binding
   `manager`/`member` activates the SA and grants nothing (`authorize.ts:214`).
6. An agent can start a child session of an agent its human may not run: the
   run check asks the parent's SA, which bypasses object grants (V4,
   `authorize.ts:232,371`).
7. A member prompting a shared session acts with the session CREATOR's token
   (V6, `r8.ts:564-617`).

## 2. Model

Two identities per agent session:

| Identity | What it decides |
|---|---|
| **Acting principal = the agent** (its service account, one per `(account, project, agent_name)`) | Everything on SHARED resources: project/account permissions, shared connector accounts, project secrets, Apps, git. |
| **On behalf of = the human** (nullable) | Only that human's OWN resources, and only in that human's own private session. |

Unattended runs have no "on behalf of". They get the agent's authority and no
personal resources. Every audit row names both: `actor = agent`,
`on_behalf_of = human | null`, `initiator = human | trigger | channel`.

### 2.1 Agent authority (shared resources)

```
effective(agent, action) =
      action ∈ kortix_permissions(agent)              -- kortix.yaml, source of truth
  AND action ∈ ceiling(agent)                         -- IAM, admin-set
  AND action ∉ HUMAN_ONLY
```

- `kortix_permissions` is read from the manifest on the default branch, exactly
  as `kortix_cli` is today (deny by default in v2; `all` allowed).
- `ceiling(agent)` = the role(s) bound to the agent's service account in IAM.
  With no binding the ceiling is the built-in default `AGENT_DEFAULT_CEILING`
  (every grantable project permission). System AND custom roles work for a
  service account (fixes the trap in §1.5).
- `HUMAN_ONLY` = `project.members.manage`, `project.delete`,
  `project.credentials.issue`. Never grantable to an agent.
- The launcher's role is NOT an input.
- `project.read` is always granted inside the agent's own project.
- The platform `meta` coordinator keeps its platform grant (unchanged).
- A project with no `agents:` map (ungoverned, null grant) keeps the legacy
  model until it declares agents. The flag (§5) only applies to governed agents.

### 2.2 "May run agent X" is the delegation

Because the launcher no longer caps the agent, running agent X lends X's power.
The existing agent object grant ("who may run which agent", closed by default)
is the control. It is enforced at EVERY entry point:

| Entry point | Required |
|---|---|
| session create / start / prompt / agent switch | `run(human, X)` (exists) |
| manual trigger fire | `run(firer, X)` (NEW, closes V2) |
| child session spawned from an agent session | `run(on_behalf_of, Y)`; with no human, only `Y == X` (NEW, closes V4) |
| trigger / channel binding that names X | merged by a human (see 2.4) |

### 2.3 Personal resources (on behalf of)

A resource owned by one human is reachable by an agent session only when:
`owner == on_behalf_of` AND the session is `private`.

| Personal resource | Code |
|---|---|
| member-owned connector connection | `connectionIsReachable` (`projects/lib/connection-access.ts`), `owner_type = 'member'` |
| personal project secret | `project_secrets.owner_user_id` |
| personal provider key | `account_secret_grants.user_id` |
| own computer (Agent Computer Tunnel) | connector gateway `tunnelAccountIds` |

`on_behalf_of` = the human who started the session, set only for a
human-initiated session. Shared sessions never expose personal resources.

A private session can still be prompted by someone else: account admins can
open members' private sessions when `accounts.admins_see_all_sessions` is on
(IAM-40, #7490). The first prompt from any human other than `on_behalf_of`
clears `on_behalf_of` on the session token, permanently for that session. The
agent keeps its own authority; it loses the creator's personal resources. So
the person prompting never acts through another person's accounts (closes V6).
A prompt that arrives without the HTTP prompt route follows the same rule at
delivery (`channelPrompterForOnBehalfOf`, `projects/lib/on-behalf-of.ts`): a
trigger fire, an email or Telegram message, and a Slack or Teams message from
an unlinked sender are non-human prompters and clear any value; a linked Slack
or Teams sender clears it when that sender is a different human. Platform
notifications (`system:*`) clear nothing.

### 2.4 Governance: widening needs a human

`kortix.yaml` is the source of truth, so whoever lands on the default branch
shapes agents. Guards:

1. The ceiling (§2.1) is IAM, admin-only. The manifest never exceeds it.
2. An agent-session credential cannot merge a change request whose diff touches
   `kortix.yaml` `agents.*` or `triggers` (`403 CR_AGENT_GOVERNANCE_CHANGE`).
   A human with `project.gitops.merge` merges it.

### 2.5 Apps as an agent resource

New per-agent grant `apps:` (array of App slugs | `all` | `none`, default
`none`), valid when the project has Apps enabled:

```yaml
agents:
  report-writer:
    kortix_permissions: [project.file.read, project.connector.read, project.app.read]
    connectors: [reports-dashboard-api]
    secrets: [REPORTS_API_KEY]
    apps: [reports-dashboard]
```

App gate decision for an agent-session credential (same project only):

| App mode | Agent allowed when |
|---|---|
| `public` | always (unchanged) |
| `project` | `project.app.read ∈ effective(agent)` |
| `restricted` / `private` | slug ∈ `apps` AND `project.app.read ∈ effective(agent)` |
| `password` | never (unchanged) |

Credential carriage: the gate accepts the Kortix credential in
`Authorization: Bearer` (exists) OR in `X-Kortix-App-Authorization: Bearer`
(new). The gate deletes `X-Kortix-App-Authorization` before forwarding, so an
App keeps `Authorization` for its own key. When a connector call targets an App
of the same deployment and project, the connector layer attaches a short-lived
signed assertion for the calling session in `X-Kortix-App-Authorization`.

### 2.6 Audit fields

Every audit row an agent-session credential produces carries:

| Field | Value |
|---|---|
| `actor_type` | `agent` |
| `agent_id` / `agent_name` | the agent's service account / agent name |
| `on_behalf_of_user_id` | the human (column added by migration `20260922144740453`), else `null` |
| `initiator_actor_type` / `initiator_actor_id` | `human` + user id (on_behalf_of set, or the creator of a cleared private session); `trigger` + trigger slug; `channel` + platform; `system` (+ service-account id for a backend session) |
| `actor_user_id` | flag ON: `on_behalf_of_user_id` (never the owner stand-in of a trigger run). Flag OFF: the token user, unchanged. |

One resolver writes these fields for API requests (`auditApiRequest`), sandbox
OpenCode ingestion, and the Git proxy (`shared/agent-audit-attribution.ts`).
The Git proxy records `git.clone` (each `git-upload-pack` transfer) and
`git.push` (each `git-receive-pack`, with `metadata.refs[] = {ref, old_sha,
new_sha, kind, denied_reason?}`; a push the ref policy refuses is `outcome:
denied`). The integrity digest includes `on_behalf_of_user_id` only when it is
not null, so rows written before the column existed keep their stored hash.

### 2.7 Where the personal-resource rule is enforced

`projects/lib/personal-resources.ts` holds the one rule. Readers:

- connector connections: `connectionIsReachable({ agentPrincipal })` through
  session resolution, the catalog, `.../connectors/:slug/accounts`, and the
  project connections list/mutate routes;
- own computers: the Computer Tunnel owner filter in the connector gateway;
- personal project secrets: sandbox env build, env hot-push, network boundary,
  secret relay/broker, the secrets list, and personal-override writes
  (`403 personal_resource_unreachable` for an agent session without the right
  on-behalf-of human);
- personal provider keys: `AuthedPrincipal.personalUserId` in the LLM gateway
  (pools, the default ChatGPT connection, the Codex override, the model picker).

`effectiveRole` for an agent-principal session is `manager` only when the agent
itself holds `project.write`, never the launcher's role.

## 3. Terminology

| Old | New |
|---|---|
| `agents.<a>.kortix_cli` | `agents.<a>.kortix_permissions` |
| `AgentGrant.kortixCli` | `AgentGrant.permissions` (stored JSON reader accepts legacy `kortixCli`) |
| "Kortix CLI actions" (UI/docs) | "Kortix permissions" |

`kortix_cli` stays accepted as a deprecated alias with a validation warning.
Both keys on one agent with different values is a validation error. Public SDK
types gain the new name; the old stays as a `@deprecated` alias.

## 4. Denials carry their reason

Every 403 from `authorize` carries `code` = the verdict reason
(`agent_scope_insufficient`, `agent_ceiling_insufficient`,
`project_role_insufficient`, `token_out_of_scope`, `agent_not_accessible`, …) and
`action`. The CLI hint is chosen from the code: "add `<action>` to
`agents.<a>.kortix_permissions`" only for `agent_scope_insufficient`; "ask an
admin to raise agent `<a>`'s role" for the ceiling.

## 5. Rollout

Project feature flag `agent_principal` (default OFF). OFF = today's model,
byte for byte. ON = §2 for governed agents. The flag flips to default ON in a
later release after dev and staging verification; that release note states the
behaviour change.

## 6. Verification contract (flows `AGP-*`)

Real HTTP and real CLI/git processes, local profile, each with read-back:

- AGP-1 alias: `kortix_cli` validates with a deprecation warning; `kortix_permissions` is canonical; both with different values → 400.
- AGP-2 flag ON: a project `member` launches agent X with `kortix_permissions: [project.file.read]` → `files ls` 200 (member alone gets 403). Same agent, owner launcher, action outside the list → 403 `agent_scope_insufficient`.
- AGP-3 flag OFF: identical requests reproduce today's launcher ∩ grant results.
- AGP-4 ceiling: an admin binds system role `member` to X's service account → an action outside `member` is 403 `agent_ceiling_insufficient`; `project.read` still 200 (the trap is gone).
- AGP-5 HUMAN_ONLY: `project.members.manage` in the list → denied.
- AGP-6 trigger fire by a member without `run(X)` → 403 `agent_not_accessible`; with it → the session's token authorizes as X, `on_behalf_of` null.
- AGP-7 child spawn: agent X session starts agent Y the human may not run → 403.
- AGP-8 personal connector: private session of human H reaches H's member-owned connection; a shared session, a trigger session, and the same private session after an admin prompts it do not.
- AGP-9 restricted App: agent listed in `apps` → 200 through `Authorization` and through `X-Kortix-App-Authorization`; unlisted agent → 401 `app_auth_required`; the App upstream never receives `X-Kortix-App-Authorization`.
- AGP-10 governance: an agent-session merge of a CR that widens `kortix_permissions` → 403 `CR_AGENT_GOVERNANCE_CHANGE`; a human merge → 200.
- AGP-11 audit: an agent action records `agent_name`, `on_behalf_of`, initiator; a trigger action records initiator `trigger` and no human.
- AGP-12 denial body: each 403 above carries `code` and `action`.
