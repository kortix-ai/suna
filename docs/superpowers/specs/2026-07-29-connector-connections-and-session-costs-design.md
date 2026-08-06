# Connections and session costs

**Date:** 2026-07-29

**Status:** Approved by direct user request

## Objective

Define connector access as reusable connectors with connection-level permissions.

Separate each connector from the connections that supply its
credentials.

Expose session secret and connector scope in the main web session UI.

Use session cost as the only usage-attribution system.

## Terminology

- A connector is an agent-facing permission package for one provider
  app.
- A connection is one connected account or credential for a connector.
- A project connection is available to eligible project members.
- A user connection belongs to one project member.
- A connector slug is its stable manifest and agent reference.
- A provider app reference identifies the upstream app independently from the
  connector slug.

The product uses `project`. It does not use `team` for connection ownership.

The existing `connectors` table stores connectors.

The existing `connector_connections` table stores connections.

These internal table names do not define the public product terminology.

## Connector contract

Each connector contains:

- a project-unique slug
- a human-readable name
- a provider type
- an independent provider app reference
- one authorization strategy
- connector policies

The authorization strategy is exactly one of:

- `project`
- `user`

The contract does not support a `both` strategy.

Multiple connectors can reference the same provider app.

For example, one project can define `gmail-read` and `gmail-send`.
Both connectors can reference the `gmail` provider app.
Each connector has independent policies and connections.

## Manifest contract

`kortix.yaml` stores the connector definition.

```toml
[[connectors]]
slug = "gmail-read"
name = "Gmail read only"
provider = "pipedream"
app = "gmail"
authorization_strategy = "user"

[[connectors.policies]]
match = "search_email"
action = "always_run"
```

The parser and serializer preserve:

- `slug`
- `name`
- provider configuration
- provider app reference
- `authorization_strategy`
- policies

Legacy connector entries without `authorization_strategy` resolve to
`project`.

The connector hash includes `authorization_strategy`.

The add-app flow collects a name, a project-unique slug, and an authorization
strategy.

## Authorization rules

A `project` connector accepts active project connections.

Eligible project members can use an active project connection.

A `user` connector accepts active connections owned by the acting
project member.

A member cannot use another member's connection.

A service account cannot impersonate a member to use a user connection.

Managed system connections remain valid only for the connectors that
explicitly support them.

The server enforces the connector strategy during:

- session creation
- default binding resolution
- explicit binding
- mid-session rescope
- connector execution

## Policy ownership

Connector policies belong only to the connector.

Every connection under the connector inherits the same policies.

Project guardrails continue to apply above connector-connection policies.

Authorization-specific policies are removed from:

- API routes
- SDK methods and types
- web controls
- runtime policy precedence

The first deployment leaves the unused
`connection_policies` table in place.

A later contract migration can drop the table after every deployed runtime no
longer reads it.

## Agent binding and required connections

An agent references connectors by slug in `connectors`.

An agent can declare mandatory connectors in
`connectors_required`.

Every `connectors_required` entry must also exist in `connectors`.

The legacy `connectors_personal` field is accepted only as a deprecated import
alias.

New manifests, serializers, SDK methods, and web controls use
`connectors_required`.

The connector authorization strategy decides which connection owner
is valid.

The agent definition does not decide project-versus-user ownership.

## Session start gate

Session creation resolves every mandatory connector before sandbox
startup.

If a valid connection does not exist, the API returns `409` with:

```json
{
  "code": "CONNECTOR_CONNECTION_REQUIRED",
  "message": "Connect the required connectors before starting this session.",
  "connector_connections": [
    {
      "id": "connector-connection-id",
      "slug": "gmail-read",
      "name": "Gmail read only",
      "authorization_strategy": "user"
    }
  ]
}
```

The main web UI renders a connection action from this response.

The action opens the connection flow for the missing connector.

If the required slug has no configured connector, the API returns
`409` with:

```json
{
  "error": "Required connector \"gmail-read\" is unavailable",
  "code": "REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE"
}
```

The session does not start until all mandatory connectors resolve.

## Session scope contract

The main web session UI exposes:

- the active secret allowlist
- one connection selection for each active connector

The scope UI stays compact and secondary to the prompt composer.

The API exposes authoritative scope read-back.

The SDK exposes scope read-back and replacement.

Connector bindings use:

- connector slug as the binding key
- `connection_id` as the selected credential source

The server can accept deprecated `connection_id` input during the compatibility
window.

Each update replaces the complete secret allowlist and connector-binding map.

An omitted secret or connector binding loses access.

An update cannot grant:

- a secret outside the caller's allowed project secrets
- a connector outside the agent or session grant
- a connection that violates the connector strategy
- another member's user connection

The accepted scope applies to the next prompt or tool call.

The session does not restart.

## Usage-attribution removal

`end_user_ref` and `origin_ref` stop being product concepts.

The API and runtime stop:

- accepting them during session creation
- storing them on new sessions or usage events
- using them in idempotency
- exporting them to sandbox environments
- filtering or grouping usage by them
- enforcing per-reference concurrency or spend limits

The SDK, docs, examples, web app, and white-label demo remove these fields.

External wrapper applications own their own customer metadata.

The first deployment leaves the unused database columns and indexes in place.

A later contract migration can remove those columns after every deployed
runtime stops reading and writing them.

## Unified session-cost contract

Every session has one cost record.

Session ownership supplies attribution.

The cost record combines:

- finalized LLM cost
- sandbox compute cost
- total cost
- owner identity
- project identity
- request and token totals
- model usage
- compute duration
- ledger entries

The API exposes:

- an account-level paginated session-cost list
- a project-filtered session-cost list
- one session-cost detail

The SDK exposes typed billing methods and `session.cost()`.

The existing project gateway session-cost route uses the same aggregation.

Usage not associated with a session appears as a separate reconciliation total.

The account billing UI renders a session-first cost explorer.

Each row shows:

- session
- project
- owner
- LLM cost
- compute cost
- total cost

The row can reveal the detailed ledger.

Dynamic cost values use tabular numerals.

## Compatibility and deployment

The database change is additive.

`connectors.authorization_strategy` defaults to `project`.

Old API instances can ignore the new column.

New API instances can read old rows after the backfill.

Published SDK connection names remain deprecated aliases where they
describe a connection.

New SDK surfaces use connection terminology.

Deprecated aliases must not reintroduce connection-specific policies,
`end_user_ref`, or `origin_ref`.

Physical database cleanup is a separate contract deployment.

## Completion conditions

- Two connectors can reference the same provider app.
- Duplicate connector slugs fail deterministically.
- Manifest parse and serialization preserve every connector-connection field.
- Connector policies apply to two different connections.
- No connection-specific policy can override a connector policy.
- Project strategy accepts eligible project members.
- User strategy accepts only the acting member's connection.
- Session creation returns the structured `409` for a missing mandatory
  connection.
- The main web UI starts the correct connection flow from that error.
- Scope read-back returns the current secret and connector selections.
- Mid-session replacement changes the next prompt without a restart.
- Negative rescope tests prove that replacement cannot broaden access.
- New sessions and usage events do not store end-user or origin references.
- The API does not filter or group usage by those references.
- Session cost reconciles finalized LLM and compute costs.
- The SDK can fetch one known session cost.
- The account billing UI shows session, owner, LLM, compute, total, and ledger
  data.
- API, SDK, manifest, database, web, and white-label tests pass.
- SDK typecheck, full test, and packed-install smoke pass.
- A real local HTTP session proves start-gate and cost behavior.
- Chromium proves the main web scope controls and outgoing replacement payload.
- The merged SHA deploys to dev.
- Dev verification repeats the HTTP and browser assertions.
