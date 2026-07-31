# Connector profile authorization and session costs implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-connector-profile-authorization-and-session-costs-design.md`

## Task 1: Connector profile contracts

- Add RED manifest, database, API-contract, and SDK tests.
- Add `authorization_strategy: project | user` to connector profiles.
- Preserve connector profile name, slug, provider app, strategy, and policies
  through manifest parse and serialization.
- Add authorization terminology to API and SDK contracts.
- Remove authorization-specific policy methods and runtime precedence.
- Apply the additive migration to the isolated database.

## Task 2: Strategy-based session authorization

- Add RED session-create and binding tests.
- Add `connectors_required` to agent manifests.
- Accept `connectors_personal` only as a deprecated import alias.
- Resolve project and user authorizations from connector profile strategy.
- Return `CONNECTOR_AUTHORIZATION_REQUIRED` before sandbox startup.
- Enforce strategy during create, default binding, explicit binding, and
  rescope.
- Add scope read-back and `authorization_id` binding terminology.

## Task 3: Main web session scope

- Read the closest session and customize reference components.
- Add component tests for missing-authorization and rescope states.
- Add a compact composer control for secrets and connector authorizations.
- Render the missing-authorization connection action.
- Use the single SDK client for read-back, replacement, and authorization.
- Verify replacement payloads and next-prompt behavior in Chromium.

## Task 4: Remove end-user usage attribution

- Add RED API and SDK contract tests for the reduced surface.
- Remove `end_user_ref` and `origin_ref` from session, usage, runtime, SDK,
  docs, examples, and demo code.
- Remove per-reference idempotency, concurrency, and spend-limit behavior.
- Remove end-user usage filtering, grouping, and web controls.
- Keep unused database columns for a later contract migration.

## Task 5: Unified session costs

- Add RED aggregation, HTTP, SDK, and UI tests.
- Add account-level paginated session-cost list and session-cost detail routes.
- Combine finalized LLM and sandbox compute costs.
- Resolve session owner and project identity.
- Return detailed ledger entries and non-session reconciliation.
- Add typed SDK billing methods and `session.cost()`.
- Reuse the aggregation in the existing project gateway route.
- Replace the account end-user usage card with the session cost explorer.

## Task 6: White-label and documentation alignment

- Remove end-user attribution from the white-label demo.
- Align the demo scope controls with authoritative scope read-back.
- Update manifest, API, SDK, and product documentation.
- Update the API route manifest and end-to-end source of truth.
- Run white-label boundary, typecheck, build, and test gates.

## Task 7: Local verification

- Run focused RED/GREEN tests for every task.
- Run affected package typechecks and full test suites.
- Run SDK typecheck, full tests, and packed-install smoke.
- Run database migration verification.
- Exercise connector start-gate, rescope, and session-cost routes over real
  local HTTP.
- Drive the main web UI in Chromium.
- Assert visible state and outgoing network payloads.
- Record exact evidence in `packages/sdk/PROGRESS.md`.

## Task 8: Delivery and dev proof

- Push the branch under the configured git identity.
- Open a PR against `main` under the authenticated GitHub account.
- Wait for every required check.
- Fix failures and repeat verification.
- Merge only after every required check passes.
- Follow Deploy Dev to completion.
- Prove the deployed artifact contains the merge SHA.
- Repeat connector, scope, and session-cost assertions on dev.
