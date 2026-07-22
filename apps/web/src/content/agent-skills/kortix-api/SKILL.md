---
name: kortix-api
description: Authenticate against and call the Kortix REST API at api.kortix.com/v1.
---

# Calling the Kortix API

Kortix exposes a REST API at `https://api.kortix.com/v1`. The full machine-readable
contract is the OpenAPI document at `https://api.kortix.com/v1/openapi.json`;
browsable reference docs are at `https://api.kortix.com/v1/docs`.

## Before you start

Fetch the OpenAPI document and work from it. It is the source of truth for every
path, parameter, and response shape. Do not guess endpoint names.

## Authenticating

Kortix uses OAuth 2.0 authorization code flow with mandatory PKCE (`S256`).

1. Read `https://kortix.com/.well-known/oauth-authorization-server` for the
   current endpoint URLs.
2. Redirect the user to the authorization endpoint with `response_type=code`,
   your `client_id`, your `redirect_uri`, the scopes you need, and a
   `code_challenge`.
3. Exchange the code at the token endpoint, sending `client_id` and
   `client_secret` in the form body.
4. Send `Authorization: Bearer <access_token>` on every API call.

Credentials are provisioned by the Kortix team, not self-service. See
`https://kortix.com/auth.md`.

## Checking availability

`GET https://api.kortix.com/v1/health` returns the service status. Use it before
a long run rather than discovering an outage mid-task.

## Rate limits

The token endpoint allows 20 requests per minute per client. Cache access tokens
and refresh them rather than re-running the authorization flow.
