# Discover integration marketplace

## Product contract

Replace the Pipedream-only "Easy Connect" catalogue with one Discover marketplace.
The default inventory is the complete public integrations.sh index. Direct provider
surfaces are the primary path: OpenAPI, Postman, MCP, GraphQL, HTTP documentation,
and CLI metadata remain visibly attributed to their real source.

Pipedream is not a generic API proxy. It contributes only applications whose
Pipedream `auth_type` is exactly `oauth`. Those applications may appear as separate
cards, are always labelled `Pipedream OAuth`, and are ordered after direct catalogue
results. API-key Pipedream apps are excluded because Kortix can connect to those APIs
directly without an intermediary.

Built-in channels such as Slack remain in Channels and are excluded from Pipedream.

## Data flow

1. The API fetches and validates `https://integrations.sh/api.json`, caches it in
   memory, and serves searchable cursor pages. The browser never calls the third
   party directly.
2. Selecting a direct card asks the API for that domain's
   `https://integrations.sh/api/{domain}/surface` document. The API normalizes all
   domain surfaces into executable and documentation-only variants.
3. Executable OpenAPI, MCP, and GraphQL variants become existing connector drafts.
   Base-URL/docs-only and CLI variants remain discoverable but link to documentation
   instead of creating an empty connector.
4. The existing Pipedream catalogue endpoint remains independently paginated but
   returns OAuth apps only.

## Reliability and safety

- Use bounded upstream timeouts, schema guards, a TTL cache, request coalescing, and
  stale-on-refresh-failure behavior.
- The detail endpoint resolves domains only from a previously validated catalogue
  record; user input never becomes an arbitrary fetch target.
- Do not persist or vendor integrations.sh data. Retain upstream IDs, icons, domains,
  formats, and documentation URLs for attribution.
- A catalogue outage must produce an explicit retryable error and must not disable
  Channels or Custom connector creation.

## Public SDK additions

Add typed, additive catalogue records, surface variants, list/detail functions, and
the Pipedream `authType: 'oauth'` field. No existing export or connector contract is
renamed or removed.

## Acceptance criteria

- Discover is the default add-connector tab even when Pipedream is not configured.
- Search returns integrations.sh records and separately-labelled Pipedream OAuth
  alternatives in the same marketplace grid.
- Pipedream `keys`, `none`, or missing-auth apps never appear.
- A real integrations.sh OpenAPI record can be added and synchronized through the
  existing connector path; a real remote MCP record can be added when it has an
  endpoint.
- HubSpot/Notion-style docs-only surfaces remain listed and clearly explain why they
  need manual configuration instead of presenting a broken Connect button.
- Slack appears only as the built-in channel.
