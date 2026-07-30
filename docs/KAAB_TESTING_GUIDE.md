# Test Kortix as a Backend

This guide verifies the current backend session contract.

It covers:

- backend session creation
- connector-profile authorization strategy
- required connector profiles
- authoritative session scope
- unified session costs
- idempotent retries
- the white-label reference app

## A. Configure the target

Set these shell variables:

```bash
export KORTIX_API_URL="https://dev-api.kortix.com/v1"
export KORTIX_API_KEY="kortix_pat_..."
export PROJECT_ID="..."
export CURL_STATUS='%{stderr}HTTP %{http_code}\n'
```

The API key must have access to `PROJECT_ID`.

Verify authentication:

```bash
curl -sS -w "$CURL_STATUS" "$KORTIX_API_URL/projects" \
  -H "Authorization: Bearer $KORTIX_API_KEY" |
  jq '{count: length}'
```

Expected:

- HTTP `200`
- a JSON array

## B. Create a backend session

Generate one idempotency key:

```bash
export CREATE_KEY="$(uuidgen)"
```

Create the session:

```bash
curl -sS -w "$CURL_STATUS" -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  -d '{
    "runtime_context": {
      "ticket_id": "ticket-123"
    }
  }' |
  tee /tmp/kortix-session.json |
  jq '{session_id, origin, status}'
```

Expected:

- HTTP `201`
- `origin` equals `backend`
- `session_id` is present
- `status` is `provisioning`

Store the identifier:

```bash
export SESSION_ID="$(jq -r '.session_id' /tmp/kortix-session.json)"
```

Your application must store customer metadata outside Kortix. Associate that
metadata with `SESSION_ID` in your application database.

## C. Verify idempotency

Replay the same key and body:

```bash
curl -sS -w "$CURL_STATUS" -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  -d '{
    "runtime_context": {
      "ticket_id": "ticket-123"
    }
  }' |
  jq -r '.session_id'
```

Expected: the response returns `SESSION_ID`.

Replay the key with changed runtime context:

```bash
curl -i -sS -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  -d '{
    "runtime_context": {
      "ticket_id": "ticket-456"
    }
  }'
```

Expected:

- HTTP `409`
- `code` equals `IDEMPOTENCY_CONTEXT_CONFLICT`

Send a 256-character key:

```bash
curl -i -sS -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(printf 'x%.0s' {1..256})" \
  -d '{}'
```

Expected:

- HTTP `400`
- `code` equals `INVALID_IDEMPOTENCY_KEY`

## D. Verify secret scope

List project-secret identifiers:

```bash
curl -sS -w "$CURL_STATUS" "$KORTIX_API_URL/projects/$PROJECT_ID/secrets" \
  -H "Authorization: Bearer $KORTIX_API_KEY" |
  jq '.items[] | {identifier, name, scope}'
```

Create a session with no project secrets:

```bash
curl -sS -w "$CURL_STATUS" -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"secrets":[]}' |
  jq '{session_id, secrets_allowlist}'
```

Expected:

- HTTP `201`
- `secrets_allowlist` equals `[]`

Use an unknown identifier:

```bash
curl -i -sS -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"secrets":["NOT_A_REAL_SECRET"]}'
```

Expected:

- HTTP `404`
- `code` equals `SECRET_IDENTIFIER_NOT_FOUND`

## E. Verify connector authorization strategy

Declare two connector profiles for one provider app:

```yaml
connectors:
  - slug: gmail-project
    name: Shared Gmail
    provider: pipedream
    app: gmail
    authorization_strategy: project
    policies:
      - match: "*"
        action: require_approval

  - slug: gmail-user
    name: Personal Gmail
    provider: pipedream
    app: gmail
    authorization_strategy: user
    policies:
      - match: search_email
        action: always_run
      - match: "*"
        action: block

agents:
  support:
    connectors: [gmail-project, gmail-user]
    connectors_required: [gmail-project]
```

Merge the manifest change before continuing.

### E1. Create a project authorization

Create the authorization through the SDK:

```ts
const project = kortix.project(projectId);

const authorization = await project.connectors.authorizations.reconcile({
  connector_alias: "gmail-project",
  owner_type: "project",
  label: "Support inbox",
});

console.log(authorization.profile_id);
```

Complete the connector's credential or OAuth flow. Then activate the
authorization.

Store the printed compatibility identifier:

```bash
export AUTHORIZATION_ID="<authorization-profile-id>"
```

### E2. Bind the authorization

```bash
curl -sS -w "$CURL_STATUS" -X POST \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "support",
    "connector_bindings": {
      "gmail-project": {
        "authorization_id": "'"$AUTHORIZATION_ID"'"
      }
    }
  }' |
  tee /tmp/kortix-connector-session.json |
  jq '{session_id, status}'
```

Expected: HTTP `201`.

Store this session. It uses the `support` agent and its connector grant:

```bash
export CONNECTOR_SESSION_ID="$(
  jq -r '.session_id' /tmp/kortix-connector-session.json
)"
```

### E3. Reject a strategy mismatch

Try to bind a member authorization under the `project` connector profile.

Expected:

- HTTP `404`
- `code` equals `CONNECTOR_PROFILE_NOT_FOUND`

The response does not reveal whether the rejected authorization exists.

### E4. Verify the required-profile gate

Revoke the `gmail-project` authorization. Then create a session for the
`support` agent without an explicit binding.

Expected:

- HTTP `409`
- `code` equals `CONNECTOR_AUTHORIZATION_REQUIRED`
- `connector_profiles[0].slug` equals `gmail-project`
- `connector_profiles[0].authorization_strategy` equals `project`
- no sandbox starts

Reactivate the authorization. Retry the create request.

Expected: HTTP `201`.

## F. Verify authoritative session scope

Read scope:

```bash
curl -sS -w "$CURL_STATUS" \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$CONNECTOR_SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" |
  jq .
```

Expected:

- `secrets_allowlist` is present
- `connector_bindings` is present
- each binding contains `authorization_id`

Replace the complete connector binding map:

```bash
curl -sS -w "$CURL_STATUS" -X PUT \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$CONNECTOR_SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_bindings": {
      "gmail-project": {
        "authorization_id": "'"$AUTHORIZATION_ID"'"
      }
    }
  }' |
  jq .
```

Expected:

- HTTP `200`
- the response contains the selected `authorization_id`
- the update does not restart the session
- the next connector call uses the new authorization

Replace the secret allowlist:

```bash
curl -sS -w "$CURL_STATUS" -X PUT \
  "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$CONNECTOR_SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"secrets":[]}' |
  jq '{secrets_allowlist, dropped_secrets, retroactive, detail}'
```

Expected:

- `secrets_allowlist` equals `[]`
- `dropped_secrets` contains identifiers removed from a previous explicit
  allowlist
- `retroactive` equals `false` when `dropped_secrets` is non-empty
- a `null` to `[]` transition returns an empty `dropped_secrets` list and
  `retroactive: true`

The next prompt does not receive the removed secret. An existing model context
or process can still retain a previously disclosed value.

## G. Verify unified session costs

List the project sessions:

```bash
curl -sS -w "$CURL_STATUS" \
  "$KORTIX_API_URL/usage/session-costs?project_id=$PROJECT_ID&limit=25&offset=0" \
  -H "Authorization: Bearer $KORTIX_API_KEY" |
  tee /tmp/kortix-session-costs.json |
  jq '{
    total,
    limit,
    offset,
    next_offset,
    reconciliation,
    first: .sessions[0]
  }'
```

Expected:

- HTTP `200`
- `limit` equals `25`
- `offset` equals `0`
- the page contains up to 25 sessions, including zero-cost sessions
- `total` counts every matching project session
- follow `next_offset` until it is `null` to inspect every session
- each row has `llm_cost`, `compute_cost`, and `total_cost`
- each row has owner and project identity
- `reconciliation` is present

Read one detail record:

```bash
curl -sS -w "$CURL_STATUS" \
  "$KORTIX_API_URL/usage/session-costs/$SESSION_ID?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $KORTIX_API_KEY" |
  jq '{
    session_id,
    llm_cost,
    compute_cost,
    total_cost,
    model_usage,
    ledger_entries
  }'
```

Expected:

- HTTP `200`
- `session_id` equals `SESSION_ID`
- `model_usage` is an array
- `ledger_entries` is an array
- each ledger entry has `kind` equal to `llm` or `compute`

Use an invalid page size:

```bash
curl -i -sS \
  "$KORTIX_API_URL/usage/session-costs?limit=0" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

Expected: HTTP `400`.

Use a sandbox token:

```bash
curl -i -sS \
  "$KORTIX_API_URL/usage/session-costs" \
  -H "Authorization: Bearer $KORTIX_SANDBOX_TOKEN"
```

Expected: HTTP `403`.

## H. Verify the white-label reference app

Configure wrapper mode according to
`apps/whitelabel-demo/README.md`.

Start the app:

```bash
pnpm --filter @kortix/whitelabel-demo dev
```

Verify these surfaces:

1. Create a session from the new-session dialog.
2. Select the agent, secret allowlist, and connector authorizations.
3. Open the session workbench.
4. Confirm the scope bar matches `GET /sessions/{sessionId}/scope`.
5. Replace secret and connector scope.
6. Confirm the next request sends a complete replacement.
7. Open `/session-costs`.
8. Confirm each row represents one session.
9. Confirm the page shows LLM, compute, raw total, and wrapper price.

The demo must not derive customer identity from session or usage fields. Its
server owns project access and customer metadata.

## I. Automated gates

Run the focused API contracts:

```bash
cd apps/api
pnpm exec dotenvx run -- bun test --isolate \
  src/shared/session-costs.test.ts \
  src/router/routes/usage-session-costs-http.test.ts
```

Run the white-label gates:

```bash
pnpm --filter @kortix/whitelabel-demo test
pnpm --filter @kortix/whitelabel-demo typecheck
pnpm --filter @kortix/whitelabel-demo build
```

Run the API route coverage gate:

```bash
cd tests
bun bin/ke2e.ts coverage
```

The route manifest must contain:

- `GET /v1/usage/session-costs`
- `GET /v1/usage/session-costs/:sessionId`
