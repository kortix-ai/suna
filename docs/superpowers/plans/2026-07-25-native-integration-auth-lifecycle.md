# Native integration authentication lifecycle implementation plan

**Spec:** `docs/superpowers/specs/2026-07-25-native-integration-auth-lifecycle-design.md`

## Task 1: Contracts and RED tests

- Add additive API-contract types for OAuth applications and lifecycle inputs.
- Add additive SDK types and methods.
- Add failing contract, SDK, and OAuth engine tests.
- Record the RED output before implementation.

## Task 2: Database lifecycle

- Add project-scoped OAuth application and ephemeral OAuth session tables.
- Add constraints, indexes, expiry fields, and one-time consumption fields.
- Export the new schema.
- Apply the migration to the isolated database.

## Task 3: OAuth2 protocol engine

- Generalize client authentication.
- Implement Authorization Code exchange with PKCE.
- Implement refresh-token rotation.
- Implement Device Authorization polling.
- Implement discovery and revocation.
- Route all provider requests through the SSRF guard.

## Task 4: API lifecycle routes

- Add redacted OAuth application configuration routes.
- Add discovery, Authorization Code start, callback, device start, and device
  poll routes.
- Preserve existing profile ownership checks.
- Delete local credentials during revocation for every upstream result.

## Task 5: Executor and non-OAuth request authentication

- Resolve and refresh delegated OAuth2 credentials under a database lock.
- Add typed API-key placement.
- Add generic HMAC, AWS SigV4, and mutual-TLS request authentication.
- Preserve bearer, Basic, custom header, and OAuth 1.0a compatibility.

## Task 6: SDK and web integration

- Implement the typed SDK methods.
- Add OAuth2 grant and client-authentication controls to the connector UI.
- Add browser redirect completion and device-code status handling.
- Keep provider-specific names and defaults out of the generic surface.

## Task 7: Local verification

- Run contract, API, executor, SDK, and web tests.
- Run SDK typecheck and packed-install smoke.
- Apply the migration to the isolated database.
- Exercise Authorization Code with PKCE through Chromium.
- Exercise Client Credentials and Device Authorization over HTTP.
- Verify refresh rotation, state replay rejection, revocation, and redaction.

## Task 8: Delivery and dev proof

- Update documentation and `packages/sdk/PROGRESS.md`.
- Push the branch and open a PR against `main`.
- Wait for required checks and merge.
- Follow Deploy Dev to completion.
- Prove the deployed SHA contains the merge SHA.
- Repeat generic route and browser verification on dev.

