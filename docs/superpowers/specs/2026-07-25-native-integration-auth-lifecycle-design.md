# Native integration authentication lifecycle

**Date:** 2026-07-25

**Status:** Approved by direct user request

## Objective

Provide a provider-independent authentication engine for native connectors.

The engine must support delegated OAuth2, machine OAuth2, and common non-OAuth
request authentication. No contract may contain Microsoft, SharePoint, or
provider-specific logic.

## Terminology

- A connector defines API operations and request authentication placement.
- A connection profile identifies one credential binding.
- An OAuth application defines provider endpoints and client credentials.
- An OAuth session is a short-lived authorization transaction.
- A credential contains encrypted provider tokens or request secrets.

This change does not rename connector, executor, or SDK concepts.

## Supported OAuth2 grants

The engine supports these grants:

- Authorization Code with mandatory PKCE S256.
- Client Credentials.
- Device Authorization.
- Refresh Token.

The engine does not support these deprecated grants:

- Implicit.
- Resource Owner Password Credentials.

## Supported OAuth2 client authentication

Token, refresh, revocation, and device requests support:

- `none`
- `client_secret_basic`
- `client_secret_post`
- `client_secret_jwt`
- `private_key_jwt`

Public clients use `none`. Confidential clients use one configured method.

## OAuth application configuration

An OAuth application is project-scoped or Kortix-managed.

It contains:

- Authorization endpoint.
- Token endpoint.
- Device authorization endpoint.
- Revocation endpoint.
- RFC 8414 or OpenID Connect discovery endpoint.
- Client ID.
- Encrypted client secret or private key.
- Token endpoint authentication method.
- Default scopes.
- Optional resource, audience, and provider parameters.

The API never returns client secrets, private keys, access tokens, refresh
tokens, device codes, or PKCE verifiers.

## Authorization Code lifecycle

1. An authenticated caller starts authorization for one connection profile.
2. The API checks the caller's profile mutation permission.
3. The API creates a random state value and PKCE verifier.
4. The database stores only the state hash.
5. The database binds the session to the account, project, profile, and user.
6. The API returns the provider authorization URL.
7. The provider calls the public callback route.
8. The callback hashes and consumes the state in one transaction.
9. The callback exchanges the code with the PKCE verifier.
10. The API encrypts and stores the token set on the connection profile.
11. The callback redirects to an allowlisted Kortix web origin.

The state expires after ten minutes. It is valid once.

## Device Authorization lifecycle

1. An authenticated caller starts device authorization for one profile.
2. The API requests a device code from the configured endpoint.
3. The API stores the device code encrypted.
4. The API returns the user code, verification URI, expiry, and poll interval.
5. The caller polls the Kortix status route.
6. The API polls the provider no faster than the required interval.
7. The API handles `authorization_pending` and `slow_down`.
8. The API stores the final token set and consumes the session.

The API never returns the provider device code.

## Refresh lifecycle

The executor refreshes a token before its access token expires.

- Refresh uses the configured client authentication method.
- Refresh runs under a database advisory lock for the credential.
- A rotated refresh token replaces the old token.
- If the provider omits a new refresh token, the old token remains.
- `invalid_grant` marks the profile as `error`.
- Errors never include provider secrets or token values.

## Revocation lifecycle

The profile revoke operation calls the provider revocation endpoint when one is
configured.

- The request uses the configured client authentication method.
- The API attempts to revoke the refresh token first.
- The API then attempts to revoke the access token.
- The API deletes the local credential for every remote result.
- A remote error is recorded without returning token data.
- The profile status becomes `revoked`.

## Discovery

The engine accepts RFC 8414 and OpenID Connect discovery documents.

Discovery may populate:

- `authorization_endpoint`
- `token_endpoint`
- `device_authorization_endpoint`
- `revocation_endpoint`
- supported client authentication methods
- supported scopes

Explicit configuration overrides discovery metadata.

## Egress security

Every provider endpoint must use HTTPS.

Every discovery, authorization metadata, token, device, refresh, and revocation
request uses the shared DNS-resolving SSRF guard.

Each request has:

- a ten-second timeout
- a bounded response body
- disabled redirect following unless the destination passes the guard

## Callback security

- State contains 256 bits of entropy.
- The database stores a SHA-256 state hash.
- PKCE uses a verifier with at least 256 bits of entropy.
- PKCE uses S256.
- State is account-bound, project-bound, profile-bound, and user-bound.
- State is consumed atomically.
- Callback redirects use configured Kortix web origins only.
- Callback error parameters never include provider descriptions.

## Credential storage

OAuth application secrets and token sets use project-secret encryption.

Stored delegated credentials include:

- OAuth application configuration.
- Access token.
- Refresh token.
- Token type.
- Granted scopes.
- Access-token expiry.
- Optional provider token fields needed for refresh.

The executor returns only the current access token to request assembly.

## Non-OAuth request authentication

The native connector engine supports:

- Static API key in a header.
- Static API key in a query parameter.
- Static API key in a cookie.
- Bearer token.
- HTTP Basic.
- OAuth 1.0a HMAC-SHA1.
- Generic HMAC request signing.
- AWS Signature Version 4.
- Mutual TLS.
- No authentication.

Generic HMAC and AWS SigV4 configuration defines the signed components. Mutual
TLS stores the client certificate and private key encrypted.

The first implementation wave must preserve existing bearer, Basic, custom
header, and OAuth 1.0a behavior. New signing modes must use typed credential
contracts.

## Ownership

Existing profile ownership rules remain authoritative.

- Project profiles require connector-profile management permission.
- Member profiles can be mutated only by their owner.
- Service accounts cannot impersonate member profile owners.
- Callback and device sessions retain the initiating user binding.

## API surface

The SDK exposes typed methods for:

- Save OAuth application configuration.
- Read redacted OAuth application configuration.
- Discover OAuth metadata.
- Start Authorization Code.
- Start Device Authorization.
- Poll Device Authorization.
- Read connection status.
- Revoke a connection profile.

The callback route is public and state-authenticated.

## Completion conditions

- Contract tests cover every supported grant and client authentication method.
- API tests cover state replay, expiry, ownership, callback, refresh rotation,
  device polling, revocation, redaction, and SSRF rejection.
- Executor tests prove access-token injection and refresh locking.
- SDK typecheck, test, and packed-install gates pass.
- Chromium proves Authorization Code and PKCE against a real local OAuth test
  provider.
- HTTP tests prove Client Credentials and Device Authorization.
- The merged SHA deploys to dev.
- Dev verification proves the generic routes and user-visible OAuth2 selection.

