---
title: Connector policy sets
status: planned
owner: unassigned
updated: 2026-10-24
---

# Connector policy sets

## Problem

A connector profile (one `connectors:` entry in `kortix.yaml`) carries one set of
tool rules (`policies:`). Two agents that need different rules on the same app
and the same way of connecting therefore need two profiles, and every profile
needs its own accounts and its own sign-in: Composio, Pipedream and MCP OAuth
credentials are keyed by the account row, which belongs to one profile.

Verified in code (branch `connectors-catalog`):

- `AgentSpec.connectors` is a list of slugs or `all` (`apps/api/src/projects/agents/types.ts`).
  It has no per-connector option.
- `resolveEffectiveAction` (`apps/api/src/connectors/policy.ts`) has no agent,
  account or session input. Rule scopes are: project (globs over slugs),
  profile, tool, arguments.
- Per-account rules existed (`2f3691ac95`, 2026-07-27) and were removed two days
  later (`6bfc4dcae1`): rules authored in the database could not live in git.
  The guide since says "create separate connector profiles when two
  authorizations need different policies". The `connection_policies` table is
  still there and unread.

## Goal

1. One profile per app per way of connecting. Several profiles of one app stay
   normal when they are different ways (Stripe over MCP and over its REST API):
   they have different tools and different sign-ins.
2. Accounts are connected once per profile.
3. Each agent can get a different rule set on the same profile.
4. Everything stays in `kortix.yaml` on the project's main branch. The API,
   SDK, CLI and UI edit it programmatically, as today:
   `mutateManifestWithRetry` → `commitManifest` → `commitRepoFile` on
   `project.defaultBranch` (compare-and-swap, one retry), then
   `syncProjectConnectors` copies it into the database, and the gateway enforces
   from there.

Non-goals: a `merge` command for existing duplicate profiles (they stay valid
profiles; the guidance changes so new ones are not needed); one credential
shared across profiles (an MCP OAuth token is issued to that MCP server's client
and the vendor's REST API rejects it; API keys can already be shared through
`auth.secret`).

## Manifest

```yaml
connectors:
  - slug: gmail
    provider: composio
    app: gmail
    policies:                 # base rules: every caller of this profile
      - match: delete_*
        action: block
    policy_sets:              # named rule sets an agent can be given
      read_only:
        description: Read and search, never send
        policies:
          - match: send_*
            action: block
      outreach:
        description: Send to customers, with approval
        policies:
          - match: send_email
            action: require_approval
            conditions:
              - arg: to
                match: "*@example.com"

agents:
  support:
    connectors: [gmail, stripe]
    policy_sets:              # connector slug -> set name; absent = base rules
      gmail: read_only
  sales:
    connectors: [gmail]
    policy_sets:
      gmail: outreach
```

Rules:

- A set name is `[a-z0-9][a-z0-9_-]{0,63}`; `base` is reserved (it names the
  base rules in the API and UI).
- A set's `policies` use the exact `ConnectorPolicySpec` shape (match, action,
  conditions). A set may hold zero rules (then it equals the base rules).
- `agents.<name>.policy_sets` keys must be connectors the agent is granted
  (listed, or `all`), and each value must be a set defined on that connector.
  Violations are agent parse errors (the agent is reported invalid, like other
  agent manifest errors), never silently ignored.

## Decision order

The gateway resolves one tool call as (first match wins inside each layer, the
first layer with a match decides):

1. project `policies:` (the admin guardrail; unchanged),
2. the calling agent's policy set on this connector, if it has one,
3. the connector's base `policies:`,
4. sensitive tools → `require_approval`,
5. the project `default_mode`.

A set can tighten or loosen the base rules for that agent; it cannot override
project rules. Choosing a set needs manifest write access, the same trust as
editing the base rules, so an agent cannot pick or widen its own set.

A caller with no agent (a person's PAT, a script) gets the base rules.

Fail closed: if an agent names a set that does not exist at call time (manifest
drift between parse and call), every tool call on that connector for that agent
is `require_approval`, and the audit row says why.

Audit: the existing `policy_source` gains `agent_set:<name>`. Approval requests
show the agent and the set that produced the decision.

## Data

- `connector_policies.policy_set text NULL` (NULL = base rules), index on
  `(connector_id, policy_set)`. One migration, additive.
- `sync.ts` already deletes and re-inserts a connector's policy rows from the
  manifest; it materializes each set's rows with their set name.
- Set descriptions: stored on the connector config the way other manifest
  metadata is (no new table).
- The agent's map travels with the agent grant that session tokens already carry
  (`AgentGrant` in `apps/api/src/iam/agent-scope.ts`, re-derived on manifest
  change by `session-token-grant.ts`). The gateway reads the calling session's
  agent set from there.
- The unread `connection_policies` table and its throwing SDK stubs stay as they
  are in this change (published SDK names are a contract); dropping the table is
  a separate migration later.

## Surfaces

API (all write `kortix.yaml` on main, then sync):

- `GET /connectors/projects/{id}/connectors/{slug}/policy-sets` → `{ sets: [{ name, description, rules, agents: [names] }] }`
- `PUT .../policy-sets/{name}` `{ description?, rules }` (create or replace)
- `DELETE .../policy-sets/{name}` (refused with 409 while an agent uses it, naming the agents)
- Existing `GET/PUT .../policies` keep meaning the base rules; `?set=<name>` reads/writes one set's rules.
- Agent grant edits: the existing agent CRUD accepts `policy_sets: { slug: name | null }`.

SDK (additive): `listConnectorPolicySets`, `upsertConnectorPolicySet`,
`deleteConnectorPolicySet`, `{ set }` option on the connector policy
get/set functions, `policy_sets` on the agent spec type, facade
`p.connectors.policySets.{list,upsert,delete}`. Adding `agent_set` to the policy
source union is noted as a type widening per the sdk skill.

CLI:

- `kortix connectors policy <slug> [--set <name>] ls|set|rm|clear`
- `kortix connectors policy-sets <slug> ls|create <name> [--description]|rm <name>`
- `kortix agents connectors <agent> --policy-set <slug>=<name>` (or the existing
  agent edit command's equivalent flag; match what `apps/cli/src/commands/agents.ts` has).

Web:

- Connector page, Tools tab: a set switcher above the rule list ("Base rules",
  each set, "New set…"), the same rule editor for each, and per set the agents
  that use it.
- Agent editor, connector access: per granted connector a "Rules" select
  (Base rules / each set).
- Approval cards and the audit view name the set.

Agent tools (MCP) and skills: `get_connector` lists the profile's sets and which
one the calling agent has; the `kortix-connectors` skill explains sets, how to
give an agent a set, and that several profiles of one app are for different
ways of connecting, not for different rules.

Docs: replace "create separate connector profiles when two authorizations need
different policies" with policy sets; document the decision order.

## Verification

- Unit: the resolver (each layer, first match, fail closed, no agent → base),
  manifest parse/serialize of sets and agent maps (valid, unknown set, ungranted
  connector, reserved name).
- DB suite: sync materializes sets; deleting a set used by an agent is refused.
- Flow (new `CONN-40` in `tests/src/flows/connectors.flow.ts` + spec line):
  one profile, two agents with different sets: the same tool call is allowed
  for one and blocked for the other through the real gateway; a project rule
  still wins over a set; editing a set via API changes the next call; the
  `kortix.yaml` commit on main contains the set.
- CLI and SDK: create a set, assign it to an agent, read back through
  `kortix connectors policy-sets` and the SDK.
- Browser: create a set on the connector page, pick it in the agent editor,
  see the rule apply in a session's approval card.
- A real agent session on the local stack whose agent has `read_only` on a
  connector tries the blocked tool and is refused with the set named.

## Rollout

New canonical branch `connector-policy-sets` from `dev` after #10866 is merged,
worktree with `--db` (migration). One PR; demo video; self-merge per the
contributing skill when verified, then deploy dev and re-run the flow on dev.

## Implementation decisions (engine + API, 2026-10-24)

These replace the matching parts above where they differ.

- Storage: a new table `kortix.connector_policy_sets` (`connector_id` FK
  cascade, `name`, `description`, `policies jsonb`, PK `(connector_id, name)`),
  not a column on `connector_policies`. One row per set, so the row is the
  registry: a set with zero rules is a row with `[]`. API code that predates
  sets never reads the table, so a set never applies as a base rule during a
  rollout or after a rollback. Migration `20261024063907045_connector_policy_sets.sql`.
- Missing set: `block`, reason `policy_set_missing` (not `require_approval`).
  The same holds when the set's rules fail to load, or the deps have no loader.
- A bad `agents.<a>.policy_sets` entry never invalidates the agent and is
  never dropped. An unknown set, `base`, or a non-string value stays in the
  grant and blocks that connector for the agent. A malformed map becomes
  `{"*": ""}`: every connector is blocked. `kortix validate` and the CR gate
  report an unknown set or `base` as an error, an ungranted or undeclared
  connector as a warning.
- Decision order: missing set → block; project rules; the agent's set; the
  connector's base rules; `sensitive`; `default_mode`. A set can loosen a
  base rule for its agent. A guardrail for every caller belongs in project
  `policies:`.
- Audit: `policy_source` is `policy_set`; the audit summary adds
  `policy_set`, `agent` and `manifest_commit`. The `/call` denial body adds
  `policy_set`, `agent` and a `message` when the set decided.
- Who gets which set: the grant on the principal decides. A session token
  (sandbox CLI, SDK, agent tools, MCP `call_connector` with a session) uses the
  session agent's set. A pi subagent child shares the root session's token,
  so the ROOT agent's set applies. A user token (JWT/PAT) with
  `X-Kortix-Session-Id` is refused (`403`, `resolveTokenBoundSessionId`: only a
  session token carries a session; verified on dev 2026-10-24). A PAT or
  dashboard call without a session, a
  trigger poll (`mcp-poll.ts`, `agentGrant: null`) and the platform meta agent
  get the base rules. The request body never selects a set.
- Trust boundary: assigning or changing any `policy_sets` entry needs
  `project.agent.write` and `project.connector.write` (scope route and config
  route). For a governed agent writer, `policy_sets` is a grant-ceiling
  dimension: any add, change or remove needs `project.connector.write`
  (route, CR merge). `holdsEveryGrant` is false for a writer bound by a set or
  without `project.connector.write` (direct push).
- Launching another agent (decision a): an agent that holds
  `project.session.start` can start a session as another declared agent, and
  that session runs under that agent's set, exactly as it gets that agent's
  connector grant today. Sets bound an agent only as far as its launch rights
  bound it.
- One rule writer: set rules are written only by
  `PUT .../connectors/{slug}/policies?policy_set=<name>`. The
  `.../policy-sets` routes own create, description, rename, delete and list.
- Manifest versions: `kortix_version` 2 and 3. v1 is refused
  (`unsupported_in_v1`). Channel and computer connectors cannot carry sets
  (`policy_sets_unsupported`).
- Un-grant keeps the entry: removing a connector from an agent keeps its
  `policy_sets` entry (inert until re-granted, then it applies again). Pruning
  it let a writer without `project.connector.write` move the agent onto the
  base rules in two writes (un-grant, re-grant). `changedPolicySet` counts
  every entry change, also on an un-granted connector (else: un-grant, drop
  the entry, re-grant). Removing an agent that has a set is a `policy_sets`
  change too (delete-then-declare). An
  emptied map (`policy_sets: {}`) is written as no key: the agent editor sends
  `{}` to clear the last set, because an omitted key keeps the declared value.
- Audit keys `policy_set`, `agent`, `manifest_commit` are written only when
  `policy_source` is `policy_set`; the UI reads them only then.
- MCP: there is no `get_connector`. `list_connectors` with `connector` returns
  the caller's `policy_set` and, when the caller may read the
  `.../policy-sets` route, `policy_sets: [{ name, description }]`.
