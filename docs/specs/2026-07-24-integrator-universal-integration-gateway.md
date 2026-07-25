# Integrator: Universal Integration Gateway

**Status:** Proposed architecture  
**Date:** 2026-07-24  
**Audience:** Kortix platform, API, SDK, CLI, web, security, and infrastructure owners

## 1. Decision

Kortix should replace the current Executor and Connector model with one
general-purpose system named **Integrator**.

Integrator is both:

- a control plane for API definitions, authentication, connections, actions,
  policies, and discovery;
- a data-plane gateway that executes authenticated requests for agents and
  humans.

The user-facing product area is **Integrations**.

Use these canonical terms:

| Term | Meaning |
|---|---|
| Integrator | The control plane, credential broker, catalog compiler, and execution gateway. |
| Integration Definition | A reusable description of an API and its authentication options. |
| Integration | One definition installed in a Kortix project. |
| Connection | One authenticated or unauthenticated identity for an integration. |
| Application | A managed or customer-owned OAuth developer application. |
| Action | One callable API operation. |
| Execution | One audited action or raw request. |
| Binding | A session's selection of a connection for an integration. |

The final canonical model does not use `Executor`, `Connector`, or
`Connection Profile`.

## 2. Product Goal

A human or agent must be able to add a previously unknown standards-compliant
API without a Kortix deployment.

The complete flow is:

1. Import or define the API.
2. Discover or configure authentication.
3. Register a Kortix-managed or customer-owned application.
4. Create a connection.
5. Discover actions.
6. configure policies.
7. Execute structured actions or constrained raw requests.
8. Refresh, rotate, test, and revoke credentials.
9. Audit every execution.

The system must support:

- OpenAPI and Swagger;
- Postman collections;
- GraphQL endpoints and schemas;
- remote MCP servers;
- raw HTTP APIs;
- `integrations.sh` discovery documents;
- manually defined APIs;
- public, project, agent, member, subject, and external identities.

API discovery and authentication are separate concerns. Every transport uses
the same authentication and connection runtime.

## 3. Current State

Kortix already has most execution-plane primitives:

- transport normalization for Pipedream, MCP, OpenAPI, Postman, GraphQL, and
  HTTP;
- an action catalog;
- policies and approval handling;
- execution audit records;
- server-side credential resolution;
- project, agent, member, subject, and external connection profiles;
- durable session-to-profile bindings;
- `integrations.sh` catalog ingestion;
- SDK, CLI, MCP, and web surfaces.

The current split creates three problems:

1. `Connector` describes the configured API.
2. `Executor` describes the gateway that calls it.
3. A new OAuth broker would introduce a third adjacent domain.

The current credential row stores one encrypted string. It does not model token
expiry, refresh state, scopes, audience, application ownership, certificate
material, or OAuth transaction state.

The current `integrations.sh` importer converts OAuth metadata into static bearer
input. Kortix does not acquire or refresh that token.

The published `@kortix/executor-sdk` package exposes Executor and Connector
terminology. The package version was `0.10.13` when this specification was
written.

## 4. Architecture

### 4.1 Adapt the current system

Reuse the current proven behavior:

- action normalization;
- transport invocation;
- project and session authorization;
- agent integration grants;
- policies and approvals;
- audit records;
- SSRF protection;
- Pipedream compatibility;
- profile ownership and session-binding invariants.

Do not fork or import the Nango codebase.

Use Nango as a reference for:

- dynamic provider definitions;
- applications;
- connections;
- encrypted credentials;
- OAuth lifecycle handling;
- refresh coordination;
- authenticated proxying.

Replace the current terminology and credential model. Do not rewrite working
transport or policy behavior without a behavioral requirement.

### 4.2 Package boundary

Create an internal `packages/integrator` package.

The package contains:

- integration-definition schemas;
- definition validation;
- API importers;
- authentication strategy drivers;
- credential lifecycle operations;
- catalog compilation;
- action invocation;
- authenticated raw requests;
- policy interfaces;
- audit interfaces.

The package contains no React code, Hono route declarations, or host-specific
authorization logic.

Host the package inside `apps/api` for the first cutover. Preserve a private
service interface so the package can move into a separate Integrator deployment
without changing public contracts.

### 4.3 Control plane

The control plane owns:

- integration definitions and immutable revisions;
- project integrations;
- applications;
- connections;
- encrypted credentials;
- policies;
- session bindings;
- discovery and validation;
- connection setup;
- connection testing;
- credential rotation;
- revocation.

### 4.4 Data plane

The data plane owns:

- principal and session validation;
- integration and connection resolution;
- action lookup;
- policy and approval enforcement;
- credential refresh;
- authentication injection;
- target-origin validation;
- upstream request execution;
- response normalization;
- execution audit.

Agents and humans use the same data plane. Principal type changes authorization.
It does not select another execution path.

## 5. Domain Model

### 5.1 Integration Definition

An `IntegrationDefinition` contains:

- stable key and immutable revision;
- name, description, icon, documentation, and categories;
- source and source evidence;
- one or more API surfaces;
- allowed HTTPS origins and path prefixes;
- actions or an action-generation source;
- authentication alternatives;
- required application and connection fields;
- verification operations;
- default policies.

Kortix publishes shared definitions.

Account owners can publish private definitions without a Kortix deployment.

Private definitions can declare:

- custom API origins;
- custom OAuth endpoints;
- custom scopes and audiences;
- tenant, region, and subdomain parameters;
- token-response mappings;
- request-injection rules;
- private OpenAPI or Postman sources.

Editing a definition creates a new revision. Existing integrations and
connections remain pinned. Migration to another revision is explicit.

### 5.2 Integration

An `Integration` installs one definition revision in a project.

It contains:

- `integration_id`;
- `project_id`;
- stable alias;
- selected definition revision;
- enabled state;
- project-specific public configuration;
- action-catalog revision;
- policies;
- synchronization state.

It contains no credential material.

One integration can have multiple connections.

### 5.3 Application

An `Application` represents an OAuth developer application.

Ownership is:

- `managed`: Kortix owns the provider-side application;
- `account`: the customer owns the provider-side application.

Both use the same OAuth lifecycle.

Account-owned applications are reusable across projects in the same account.

An application contains:

- definition revision;
- client ID;
- write-only client secret;
- write-only private key and certificate chain;
- supported grant types;
- redirect URI metadata;
- provider-specific public fields;
- secret revision;
- enabled state.

Changing a client secret increments its revision. Changing the client ID creates
a new application. Deleting an application with active connections returns
`409`.

Kortix-managed applications require external provider registration unless the
provider supports dynamic client registration.

### 5.4 Connection

Merge the current profile and credential concepts into `Connection`.

A connection contains:

- integration;
- owner type and owner ID;
- application;
- authentication strategy;
- provider tenant and subject;
- granted scopes;
- audience;
- status;
- verification state;
- non-secret provider metadata.

Connection ownership remains:

- project;
- agent;
- member;
- subject;
- external.

Member-owned connections remain private.

Connection states are:

- `pending`;
- `connected`;
- `reauthorization_required`;
- `revoked`;
- `error`.

### 5.5 Credential

Store encrypted credential payloads separately from connection metadata.

The encrypted payload can contain:

- API keys;
- access tokens;
- refresh tokens;
- OAuth 1 token secrets;
- certificates;
- private keys;
- provider refresh metadata.

Store expiry, revision, refresh lease, and lifecycle timestamps as non-secret
columns.

Use AES-256-GCM with a random IV and authenticated resource context. Include an
envelope version and key identifier.

Provider credentials never enter:

- sandbox variables;
- agent prompts;
- transcripts;
- SDK responses;
- browser state;
- logs;
- audit payloads.

### 5.6 Action

Every integration produces one normalized action catalog.

Actions can come from:

- OpenAPI operations;
- Postman requests;
- GraphQL fields;
- MCP tools;
- curated definitions;
- manually declared operations.

Each action contains:

- stable path;
- description;
- input schema;
- output schema when available;
- risk classification;
- required scopes;
- transport invocation metadata.

### 5.7 Execution

Every action call and raw request creates one execution record.

The record contains:

- principal;
- project and session;
- integration and connection;
- action;
- risk;
- policy decision;
- approval state;
- upstream status;
- bounded result summary;
- timestamps.

The record never contains provider credentials.

## 6. Authentication Engine

### 6.1 Strategy interface

Authentication is independent from transport.

Every strategy implements:

- `begin`;
- `complete`;
- `acquire`;
- `refresh`;
- `inject`;
- `verify`;
- `revoke`;
- `classifyFailure`.

Built-in strategies cover:

- no authentication;
- API key;
- basic authentication;
- static bearer token;
- compound credentials;
- OAuth 1;
- OAuth 2;
- OpenID Connect;
- client certificates;
- signed JWT assertions;
- request signing;
- multi-step token exchanges.

A standards-compliant OAuth provider requires configuration only. A provider
needs reviewed Kortix code only when declarative configuration cannot express
its behavior.

### 6.2 Dynamic OAuth definition

An OAuth definition can declare:

- protocol;
- issuer;
- authorization endpoint;
- token endpoint;
- refresh endpoint;
- device authorization endpoint;
- revocation endpoint;
- introspection endpoint;
- JWKS endpoint;
- dynamic registration endpoint;
- grant types;
- client-authentication methods;
- PKCE requirements;
- scopes and scope separator;
- authorization parameters;
- token-request parameters;
- refresh parameters;
- tenant and audience fields;
- token-response field mappings;
- resource-server origins;
- request-injection rules;
- verification request.

Use constrained dot paths for response extraction. Use fixed placeholders for
request templates. Do not execute JavaScript from definitions.

### 6.3 OAuth lifecycle

Support:

- authorization code;
- PKCE S256;
- client credentials;
- device authorization;
- refresh tokens;
- JWT bearer;
- token exchange;
- OIDC discovery and ID-token validation;
- authorization-server metadata;
- protected-resource metadata;
- dynamic client registration;
- token revocation;
- token introspection;
- rotating refresh tokens;
- incremental scopes;
- tenant-specific endpoints;
- `client_secret_basic`;
- `client_secret_post`;
- `private_key_jwt`;
- mutual TLS.

The callback route is generic. Signed transaction state identifies the
definition, application, connection, and flow.

### 6.4 Interactive authorization

1. Select the definition.
2. Select a managed or account-owned application.
3. Select scopes and connection fields.
4. Create a one-time authorization transaction.
5. Generate state, nonce, and PKCE values.
6. Redirect to the authorization endpoint.
7. Validate callback state and expiry.
8. Exchange the authorization code.
9. Validate the token response.
10. Encrypt the credential.
11. activate the connection.
12. Redirect to an allowlisted Kortix origin.

### 6.5 Non-interactive authorization

Client credentials perform the token request immediately.

Device authorization returns the verification URI, user code, polling interval,
and expiry. A background worker polls according to the provider response.

OAuth 1 uses the same transaction model for request-token state.

### 6.6 Refresh

Resolve connection state before every execution.

- Refresh before the configured expiry buffer.
- Run a background refresh sweep every 60 seconds.
- Use PostgreSQL leases for cross-process coordination.
- Re-read credentials after lease acquisition.
- Write rotated tokens with a credential-revision compare-and-swap.
- Preserve an unexpired credential after a transient refresh failure.
- Mark terminal provider failures as `reauthorization_required`.
- Never run two provider refresh requests for one credential revision.

## 7. Discovery

The provider builder accepts:

1. an issuer or authorization-server URL;
2. imported API or MCP metadata;
3. manual endpoint configuration.

Attempt discovery in this order:

1. OIDC discovery;
2. RFC 8414 authorization-server metadata;
3. RFC 9728 protected-resource metadata;
4. OpenAPI security schemes;
5. MCP authorization metadata;
6. `integrations.sh` discovery data;
7. manual configuration.

The result is a draft definition revision. An account owner reviews and
publishes it.

Update the existing `integrations.sh` importer to consume schema version `3`.

Preserve:

- credential definitions;
- OAuth metadata;
- OR authentication alternatives;
- AND credential requirements;
- source evidence;
- resource origins;
- scopes;
- request mechanics.

Do not convert OAuth into a bearer-token text field.

If discovery lacks required token endpoints, the result remains a draft. The UI
asks for the missing fields. It does not fabricate them.

## 8. Gateway and Proxy

### 8.1 Raw request

Every HTTP-compatible integration receives a constrained `request` action.

Input contains:

- method;
- relative path;
- query parameters;
- headers;
- body.

The request cannot target an undeclared origin.

Caller input cannot override:

- `Authorization`;
- `Cookie`;
- `Host`;
- proxy headers;
- strategy-owned authentication fields.

### 8.2 Execution flow

1. Authenticate the human or agent principal.
2. Resolve the project and session.
3. Resolve the integration alias.
4. Enforce the agent's integration grant.
5. Resolve the bound or default connection.
6. Enforce connection ownership.
7. Resolve the action.
8. Enforce policies and approvals.
9. Refresh the credential when required.
10. Validate the target origin.
11. Inject authentication.
12. Execute the upstream request.
13. Normalize the result.
14. Write the execution audit.

No transport receives raw credential values.

## 9. Public Interfaces

### 9.1 Main SDK

Move Integrator support into `@kortix/sdk`.

Do not create another permanent standalone SDK.

Expose:

```ts
const kortix = createKortix({ backendUrl, getToken });

await kortix.integrations.list(projectId);
await kortix.integrations.discover(projectId, 'send a message');
await kortix.integrations.describe(projectId, 'slack.send_message');
await kortix.integrations.call(projectId, 'slack', 'send_message', args);
await kortix.integrations.request(projectId, 'sharepoint', request);
await kortix.integrations.connections.list(projectId, 'sharepoint');
```

Add public types:

- `Integration`;
- `IntegrationDefinition`;
- `IntegrationAction`;
- `IntegrationConnection`;
- `IntegrationApplication`;
- `IntegrationExecution`;
- `IntegrationCallResult`.

### 9.2 Published Executor SDK

Replace `@kortix/executor-sdk` with a thin compatibility wrapper over
`@kortix/sdk`.

- Mark the npm package deprecated.
- Keep existing imports working for one major version.
- Keep no duplicate HTTP or business logic.
- Remove the package after the compatibility window.

### 9.3 CLI

Replace `kortix executor` with:

```text
kortix integrator integrations
kortix integrator discover
kortix integrator describe
kortix integrator call
kortix integrator request
kortix integrator connections
kortix integrator applications
```

Keep `kortix executor` as a temporary command alias. It invokes the same
implementation and prints one deprecation notice.

### 9.4 API

Management routes use resource names:

- `/v1/projects/:projectId/integrations`;
- `/v1/projects/:projectId/integrations/:integrationId/actions`;
- `/v1/projects/:projectId/integrations/:integrationId/connections`;
- `/v1/accounts/:accountId/integration-definitions`;
- `/v1/accounts/:accountId/integration-applications`.

The shared gateway uses:

- `GET /v1/integrator/catalog`;
- `POST /v1/integrator/call`;
- `POST /v1/integrator/request`;
- `GET /v1/integrator/executions/:executionId`.

Keep `/v1/executor/*` as a temporary translation layer. It calls Integrator and
contains no independent business logic.

### 9.5 Manifest

Replace:

```yaml
connectors:
```

with:

```yaml
integrations:
```

Replace agent `connectors` grants with `integrations` grants.

The parser accepts both during one compatibility window. A manifest cannot
contain both. The CLI rewrites the legacy form when it edits a manifest. New
manifests emit only `integrations`.

## 10. Persistence

Use these final table names:

- `integration_definitions`;
- `integration_definition_revisions`;
- `integrations`;
- `integration_actions`;
- `integration_connections`;
- `integration_credentials`;
- `integration_applications`;
- `integration_auth_transactions`;
- `integration_policies`;
- `integration_project_settings`;
- `integration_executions`;
- `session_integration_bindings`.

Canonical column replacements include:

- `connector_id` to `integration_id`;
- `connector_alias` to `integration_alias`;
- `profile_id` to `connection_id`.

Migrate current data while preserving UUIDs, timestamps, policies, bindings,
and audit attribution.

Pipedream account bindings become legacy connection credentials. They remain
executable until the customer reconnects natively.

## 11. Refactor and Cutover

Use a big-bang internal refactor with external compatibility adapters.

1. Build the canonical Integrator domain in an isolated worktree.
2. Move current transport, policy, approval, and audit behavior into the new
   package.
3. Migrate the database to canonical tables.
4. Switch every internal caller in one cutover.
5. Keep no second business-logic implementation.
6. Keep thin route, CLI, SDK, and manifest adapters for one major version.
7. Remove adapters after confirmed zero legacy traffic.
8. Remove old tables after the rollback window.

This creates one clean internal architecture at the first cutover.
Compatibility exists only at the system boundary.

## 12. Security Invariants

1. An integration never stores provider credentials.
2. A connection never crosses its account or project boundary.
3. A member connection is usable only by that member.
4. A session binding can narrow an agent grant. It cannot widen it.
5. Revocation takes effect on the next execution.
6. Credentials remain inside Integrator.
7. Request targets remain inside declared origins.
8. Definition templates cannot execute arbitrary code.
9. Application secrets are write-only.
10. OAuth state is single-use, signed, bounded, and expiring.
11. Refresh uses distributed coordination and credential revisions.
12. Every execution produces an audit record.

## 13. Acceptance Criteria

### 13.1 General system proof

The live test must:

1. Create a private integration definition at runtime.
2. Import an API definition.
3. Configure OAuth dynamically.
4. Add a customer-owned OAuth application.
5. Create a connection.
6. Complete authorization.
7. Discover actions.
8. Execute one action as a human.
9. Execute the same action as an agent.
10. Execute one constrained raw request.
11. Expire and refresh the credential.
12. Revoke the connection.
13. Complete all steps without a Kortix deployment.

### 13.2 SharePoint proof

Use Microsoft Graph and SharePoint as one live provider test.

Add Microsoft through the dynamic definition API. Do not add a Microsoft branch
to the gateway.

The flow must:

1. acquire a Graph token;
2. resolve a SharePoint site;
3. list document libraries;
4. read a drive delta;
5. download one file;
6. prove that no Graph credential entered the sandbox or transcript.

### 13.3 Compatibility proof

- Existing integration IDs and connection IDs remain stable.
- Existing session bindings resolve the same identity.
- Existing policies produce the same decision.
- Existing audits remain queryable.
- Existing Pipedream integrations execute.
- Legacy SDK, CLI, API, and manifest calls reach Integrator adapters.
- Canonical code contains no Executor, Connector, or Profile business logic.

### 13.4 Verification gates

- Database migration integration tests.
- Integrator package unit and integration tests.
- Full `@kortix/sdk` TDD gates.
- CLI process tests.
- Real HTTP API tests.
- Browser tests for definitions, applications, connections, and invocation.
- Agent-session execution tests.
- OAuth callback and refresh-concurrency tests.
- SSRF, cross-account, and secret-leak tests.
- PR review and merge.
- Deploy Dev completion.
- Deployed-SHA proof.
- Live human and agent execution against dev.

## 14. Non-Goals

- Do not build Nango-style record synchronization in this phase.
- Do not run arbitrary customer authentication code.
- Do not scrape browser cookies.
- Do not automate CAPTCHA or SAML browser sessions.
- Do not expose provider tokens through a generic token API.
- Do not remove Pipedream before native connections reach required parity.

## 15. Final Outcome

Integrator becomes one universal integration gateway.

A human or agent can add an API, configure authentication, create connections,
discover operations, and execute them through one governed proxy.

OAuth is one authentication subsystem inside Integrator. OpenAPI, Postman,
GraphQL, MCP, raw HTTP, policies, approvals, connections, and execution all use
the same domain model.
