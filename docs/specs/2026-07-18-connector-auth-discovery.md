# Connector authentication discovery

## Goal

Connector sources already describe authentication. Kortix must preserve and use
that information instead of asking users to reconstruct it manually. A user
should normally provide only the credential value (or complete an interactive
OAuth consent flow).

## Product contract

- Omitting `auth` means **Auto-detect**.
- Sending `auth: { type: "none" }` is an explicit opt-out and is never
  overwritten.
- Postman and OpenAPI sources are inspected before a connector is committed.
- HTTP, GraphQL, and MCP sources contribute standardized auth metadata when they
  expose it (document fields or HTTP `WWW-Authenticate` challenges).
- Every discovered scheme is returned to callers. Kortix recommends and applies
  the best executable scheme, while retaining warnings for alternatives,
  combinations, or schemes the executor cannot yet sign.
- Secret values embedded in a source are never copied, returned, logged, or
  committed. Variable names, header/query placement, prefixes, OAuth endpoints,
  flows, and scopes are metadata and may be preserved.
- Manual auth remains an override.

## Normalized discovery contract

`ConnectorAuthDiscovery` contains:

- `status`: `detected | none | ambiguous | unsupported`
- `recommended`: the existing executable connector auth shape, or `null`
- `candidates[]`: source, normalized scheme, placement/name/prefix, OAuth
  metadata, request coverage, and executor support
- `warnings[]`: conflicts, compound requirements, and unsupported signing modes

The executable auth shape remains backward compatible:
`none | bearer | basic | custom | oauth1`. OAuth 2/OpenID access tokens map to
bearer injection; API keys map to custom header/query injection. OAuth metadata
is still returned so a future managed consent flow can use it without reparsing
the source.

## Source behavior

### OpenAPI / Swagger

Read OAS 3 `components.securitySchemes`, Swagger 2 `securityDefinitions`, root
and operation `security` requirements, HTTP/basic/bearer/API-key/OAuth 1/OAuth
2/OpenID Connect/mTLS schemes, OAuth flows, URLs, and scopes. Rank by actual
operation coverage, then deterministic source order. Report AND-composed and
alternative requirements rather than silently flattening them.

### Postman

Honor collection, folder, and request auth inheritance, including explicit
`noauth`. Read Postman auth attribute arrays without retaining literal secret
values. Normalize bearer, basic, API key, OAuth 1, OAuth 2, digest, Hawk, NTLM,
AWS v4, EdgeGrid, ASAP, and unknown future types. Rank by effective request
coverage. Supported types are applied automatically; unsupported types remain
visible with an actionable warning.

Postman-managed repositories may contain both OpenAPI definitions and Collection
v2 documents. Discovery merges all of them.

### Other sources

- HTTP route documents: inspect standardized OpenAPI-style security fields and
  explicit top-level `auth` metadata when present.
- GraphQL/MCP endpoints: inspect `WWW-Authenticate`; for MCP bearer challenges,
  retain RFC 9728 protected-resource metadata links and authorization-server
  hints when provided.
- Pipedream/channels/computers keep their platform-owned authentication paths.

## UX

The connector form defaults to `Auto-detect`. Once a usable source is entered,
it previews the detected scheme, placement, and source. Users may switch to a
manual scheme or explicit `None`. Detection failure never fabricates auth; it
shows a warning and the connector may still be added.

## Safety

- Existing connectors and manifests are unchanged until edited.
- Existing callers that send an explicit auth object retain their behavior.
- Source fetches use the existing SSRF guard and project Git credentials.
- Auth discovery is metadata-only and never executes Postman scripts.

