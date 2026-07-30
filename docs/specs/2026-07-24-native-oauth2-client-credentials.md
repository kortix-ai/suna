# Native OAuth2 client credentials

Date: 2026-07-24

## Scope

This slice extends the existing Executor connection-profile credential.

It does not rename Executor or Connector. It does not add delegated user login.

## Public contract

The existing connector and profile credential routes accept one of these bodies:

```json
{ "value": "static credential" }
```

```json
{
  "oauth2": {
    "type": "oauth2_client_credentials",
    "token_url": "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    "client_id": "application client ID",
    "token_endpoint_auth_method": "client_secret_post",
    "client_secret": "application client secret",
    "scopes": ["https://graph.microsoft.com/.default"]
  }
}
```

`token_endpoint_auth_method` supports:

- `client_secret_post`
- `client_secret_basic`
- `private_key_jwt`

`private_key_jwt` signs a `PS256` assertion. Its JWT header contains `x5t#S256`.

## Storage and execution

- Kortix requests the first access token before it saves the credential.
- The encrypted credential contains the OAuth2 configuration and cached access token.
- The Executor resolves the credential on every call.
- A token with 60 seconds or less remaining is expired.
- PostgreSQL advisory locks serialize refreshes per credential row.
- The refreshed encrypted value replaces the expired value in the same transaction.
- The Executor injects only the resolved access token into the upstream request.
- Connector configuration, client secrets, private keys, and cached tokens never enter the sandbox.

## Failure and revocation

- Token endpoints must use HTTPS.
- The standard egress guard blocks private, reserved, and metadata-network destinations.
- OAuth error descriptions are not returned because providers can echo secret input.
- Token acquisition and refresh failures return a structured Executor error.
- A revoked connection profile is absent from Executor resolution on the next call.

## Acceptance

- Static credentials remain backward compatible.
- Client-secret and certificate assertion tests pass.
- Expired tokens refresh once under concurrent calls.
- Microsoft Graph resolves a real SharePoint site.
- Microsoft Graph lists the site's document libraries.
- Revocation blocks the next Executor call.
