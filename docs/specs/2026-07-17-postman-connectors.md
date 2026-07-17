# Postman connector ingestion

## Goal

Let a Kortix project declare a Postman collection, a Postman-managed Git
repository, or a public Postman workspace as one connector source. Sync turns
the source into the same normalized, policy-governed action catalog used by
OpenAPI, GraphQL, MCP, and HTTP connectors.

The HubSpot public API workspace and its synchronized Git repository are the
acceptance fixture. The repository currently contains `.postman/api` metadata
for more than one hundred product APIs, each pointing at an OpenAPI definition
and (usually) a generated Postman collection.

## Product contract

```yaml
connectors:
  - slug: hubspot
    name: HubSpot
    provider: postman
    spec: https://github.com/HubSpot/HubSpot-public-api-spec-collection
    auth:
      type: bearer
      secret: HUBSPOT_ACCESS_TOKEN
```

`spec` accepts:

1. a URL or repository-relative path to a Postman Collection v2.0/v2.1 JSON
   document;
2. a URL or repository-relative path to a `.postman/api` manifest;
3. a public GitHub repository URL containing `.postman/api`; or
4. a public Postman workspace URL. Workspace resolution uses Postman's
   supported API and a server-side `POSTMAN_API_KEY`; it never scrapes the web
   application or imports credentials embedded in collection content.

The dashboard and CLI expose `postman` beside the existing connector providers.
Existing OpenAPI behavior and manifests remain backward compatible.

## Ingestion boundary

Postman is a source provider, not an alternate executor. Source resolution
returns one or more named documents:

- `.postman/api` repositories: follow each `.postman/api_<id>` relation and
  prefer `apiDefinition.rootFiles` with `type = openapi:3`; fall back to its
  collection files when no API definition exists;
- direct collection documents: parse Collection v2.0/v2.1 recursively;
- public workspaces: list collections through the official Postman API and
  fetch their exported JSON documents.

Each document becomes normalized actions. When a source contains multiple
documents, action paths are prefixed with a deterministic document namespace.
The connector remains one manifest entry and one policy boundary:

```text
hubspot.crm_contacts.getbyid
hubspot.crm_companies.getbyid
```

Document namespaces derive from the repository path or collection name and are
deduplicated deterministically. Source ordering must not change action paths.

## Direct collection normalization

For every request item:

- folder names plus the request name produce a stable dotted action path;
- GET/HEAD/OPTIONS are `read`, DELETE is `destructive`, and other methods are
  `write`;
- collection and request variables resolve from non-secret collection defaults;
- unresolved `{{variables}}`, `:pathVariables`, query entries, and non-auth
  headers become typed string inputs;
- JSON request examples produce a `body` schema and JSON response examples
  produce an output schema;
- static query parameters and headers are retained in the invocation binding;
- collection/request auth metadata is detected for diagnostics, but token,
  password, API-key, cookie, and OAuth values are never imported;
- disabled items are ignored;
- pre-request scripts, tests, cookies, and `pm.sendRequest` are never executed;
- unsupported body modes or unresolved dynamic scripts create visible sync
  warnings instead of silently claiming full fidelity.

Execution uses a dedicated `postman` action binding so request templates and
static headers/query values survive normalization. It still calls the existing
HTTP request executor, authentication attachment, audit, approval, and policy
layers.

## Safety and limits

- Keep the existing outbound-source SSRF checks for every fetched URL.
- Follow redirects only when every destination is allowed.
- Limit individual documents, repository API counts, aggregate bytes, and
  normalized actions; return actionable errors when a limit is exceeded.
- Bound fetch concurrency and apply timeouts.
- Reject HTML/login pages and malformed collection schemas precisely.
- Do not persist source credentials or imported third-party secret values.
- Do not evaluate JavaScript from Postman content.

## Refresh and hashing

The manifest hash remains the cheap declaration hash. Source content is fetched
on explicit sync and materialized through the existing catalog hash. A changed
repository or collection replaces actions atomically; removed actions disappear.
The connector status exposes the last resolution error and warnings.

## Acceptance criteria

1. Existing connector tests and manifests remain green.
2. Direct Collection v2.1 JSON imports nested requests and executes a real HTTP
   request with path/query/header/body/auth behavior intact.
3. HubSpot's public repository URL resolves `.postman/api`, imports all usable
   API definitions, produces stable namespaced actions, and does not import its
   generated Postman collections redundantly.
4. A raw HubSpot collection imports successfully through the collection parser.
5. A public Postman workspace URL either resolves through the supported API or
   returns a precise missing-`POSTMAN_API_KEY` error.
6. API, SDK, CLI, manifest schema, dashboard, docs, and generated schemas all
   expose `postman` consistently.
7. Local black-box API/CLI/UI verification and deployed-dev verification prove
   creation, sync, catalog visibility, and a real outbound call.

