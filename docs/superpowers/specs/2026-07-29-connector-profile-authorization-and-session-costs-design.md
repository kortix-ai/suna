# Connector profile authorization and session costs

**Date:** 2026-07-29

**Status:** Approved by direct user request

## Objective

Define connector access as reusable connector profiles with profile-level
permissions.

Separate each connector profile from the authorizations that supply its
credentials.

Expose session secret and connector scope in the main web session UI.

Use session cost as the only usage-attribution system.

## Terminology

- A connector profile is an agent-facing permission package for one provider
  app.
- An authorization is one connected account or credential under a connector
  profile.
- A project authorization is available to eligible project members.
- A user authorization belongs to one project member.
- A connector profile slug is its stable manifest and agent reference.
- A provider app reference identifies the upstream app independently from the
  connector profile slug.

The product uses `project`. It does not use `team` for authorization scope.

The existing `executor_connectors` table stores connector profiles.

The existing `executor_connection_profiles` table stores authorizations.

These internal table names do not define the public product terminology.

## Connector profile contract

Each connector profile contains:

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

Multiple connector profiles can reference the same provider app.

For example, one project can define `gmail-read` and `gmail-send`.
Both profiles can reference the `gmail` provider app.
Each profile has independent policies and authorizations.

## Manifest contract

`kortix.yaml` stores the connector profile definition.

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

The connector profile hash includes `authorization_strategy`.

The add-app flow collects a name, a project-unique slug, and an authorization
strategy.

## Authorization rules

A `project` connector profile accepts active project authorizations.

Eligible project members can use an active project authorization.

A `user` connector profile accepts active authorizations owned by the acting
project member.

A member cannot use another member's authorization.

A service account cannot impersonate a member to use a user authorization.

Managed system authorizations remain valid only for the connector profiles that
explicitly support them.

The server enforces the connector profile strategy during:

- session creation
- default binding resolution
- explicit binding
- mid-session rescope
- connector execution

## Policy ownership

Connector policies belong only to the connector profile.

Every authorization under the connector profile inherits the same policies.

Project guardrails continue to apply above connector-profile policies.

Authorization-specific policies are removed from:

- API routes
- SDK methods and types
- web controls
- runtime policy precedence

The first deployment leaves the unused
`executor_connection_policies` table in place.

A later contract migration can drop the table after every deployed runtime no
longer reads it.

## Agent binding and required profiles

An agent references connector profiles by slug in `connectors`.

An agent can declare mandatory connector profiles in
`connectors_required`.

Every `connectors_required` entry must also exist in `connectors`.

The legacy `connectors_personal` field is accepted only as a deprecated import
alias.

New manifests, serializers, SDK methods, and web controls use
`connectors_required`.

The connector profile authorization strategy decides which authorization owner
is valid.

The agent definition does not decide project-versus-user ownership.

## Session start gate

Session creation resolves every mandatory connector profile before sandbox
startup.

If a valid authorization does not exist, the API returns `409` with:

```json
{
  "code": "CONNECTOR_AUTHORIZATION_REQUIRED",
  "message": "Connect the required connector profiles before starting this session.",
  "connector_profiles": [
    {
      "id": "connector-profile-id",
      "slug": "gmail-read",
      "name": "Gmail read only",
      "authorization_strategy": "user"
    }
  ]
}
```

The main web UI renders a connection action from this response.

The action opens the authorization flow for the missing connector profile.

The session does not start until all mandatory connector profiles resolve.

## Session scope contract

The main web session UI exposes:

- the active secret allowlist
- one authorization selection for each active connector profile

The scope UI stays compact and secondary to the prompt composer.

The API exposes authoritative scope read-back.

The SDK exposes scope read-back and replacement.

Connector bindings use:

- connector profile slug as the binding key
- `authorization_id` as the selected credential source

The server can accept deprecated `profile_id` input during the compatibility
window.

Each update replaces the complete secret allowlist and connector-binding map.

An omitted secret or connector binding loses access.

An update cannot grant:

- a secret outside the caller's allowed project secrets
- a connector profile outside the agent or session grant
- an authorization that violates the connector profile strategy
- another member's user authorization

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

`executor_connectors.authorization_strategy` defaults to `project`.

Old API instances can ignore the new column.

New API instances can read old rows after the backfill.

Published SDK connection-profile names remain deprecated aliases where they
describe an authorization.

New SDK surfaces use authorization terminology.

Deprecated aliases must not reintroduce authorization-specific policies,
`end_user_ref`, or `origin_ref`.

Physical database cleanup is a separate contract deployment.

## Completion conditions

- Two connector profiles can reference the same provider app.
- Duplicate connector profile slugs fail deterministically.
- Manifest parse and serialization preserve every connector-profile field.
- Connector-profile policies apply to two different authorizations.
- No authorization-specific policy can override a connector-profile policy.
- Project strategy accepts eligible project members.
- User strategy accepts only the acting member's authorization.
- Session creation returns the structured `409` for a missing mandatory
  authorization.
- The main web UI starts the correct authorization flow from that error.
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
