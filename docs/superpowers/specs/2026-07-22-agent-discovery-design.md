# Agent Discovery for kortix.com

**Date:** 2026-07-22
**Branch:** `is-it-agent-ready`
**Worktree:** `/Users/jay/root/kortix/suna-is-it-agent-ready`

## Problem

An [isitagentready.com](https://isitagentready.com) audit of kortix.com reports eleven
missing agent-discovery affordances. Kortix already publishes `llms.txt`,
`llms-full.txt`, a `/markdown/*` mirror of public content, and a paginated
`/api/ai` content index — but none of it is discoverable through the standard
entry points an autonomous agent probes first.

## Goal

Publish truthful, machine-readable discovery metadata at the standard locations
so an agent arriving at `https://kortix.com` with no prior knowledge can find the
API, its documentation, its authentication story, and its content — without
scraping HTML.

Every document must describe capabilities that **actually exist**. A discovery
document that advertises a non-existent endpoint is worse than no document,
because agents will call it and fail.

## Scope

Nine checks are implemented in code, all within `apps/web`:

1. Link response headers (RFC 8288)
2. Markdown for Agents (`Accept: text/markdown` negotiation)
3. Content Signals in `robots.txt`
4. API Catalog (RFC 9727)
5. OAuth Authorization Server metadata (RFC 8414)
6. OAuth Protected Resource metadata (RFC 9728)
7. `auth.md` agent registration document
8. Agent Skills discovery index (Agent Skills Discovery RFC v0.2.0)
9. WebMCP browser tools

Two checks are **documentation only**, because neither can be satisfied honestly
by code in this repository:

- **DNS-AID** — SVCB/HTTPS records live in a DNS zone, not a codebase.
- **MCP Server Card** — no MCP server exists anywhere in this repository. A card
  pointing at a non-existent transport endpoint would be a lie agents act on.

### Out of scope

- Building an MCP server.
- Applying DNS records (the spec produces the record set; a human applies it).
- Canonical RFC 9728 placement of OAuth metadata on `api.kortix.com` — recorded
  as a follow-up below.
- Any change to `apps/api`.

## Established facts

Verified by reading the code, not assumed:

| Fact | Source |
|---|---|
| Canonical origin is `https://kortix.com` | `apps/web/src/lib/site-metadata.ts:10` |
| REST API base is `https://api.kortix.com/v1` | `apps/web/src/features/marketing/hero-surfaces.tsx:214` |
| OpenAPI spec served at `/v1/openapi.json`, Scalar docs at `/v1/docs` | `apps/api/src/index.ts:386` |
| Health endpoint `/v1/health` exists | `apps/api/src/index.ts:333` |
| OAuth AS mounted at `/v1/oauth` | `apps/api/src/index.ts:824` |
| Endpoints: `/authorize`, `/authorize/consent`, `/token`, `/userinfo` | `apps/api/src/oauth/index.ts` |
| `response_type=code` only; PKCE **required**; `S256` only | `apps/api/src/oauth/index.ts:288-299` |
| Grants: `authorization_code`, `refresh_token` | `apps/api/src/oauth/index.ts:540-549` |
| Client auth is `client_secret_post` (credentials read from parsed body) | `apps/api/src/oauth/index.ts:510-513` |
| Tokens are opaque DB rows, not JWTs — no `jwks_uri`, no `id_token` | `packages/db/src/schema/kortix.ts:1583+` |
| Scope `profile` is enforced; `machines:read` appears in fixtures | `apps/api/src/oauth/index.ts:695` |
| **No** dynamic client registration endpoint exists | absence in `apps/api/src/oauth/index.ts` |
| Public content records + markdown rendering | `apps/web/src/lib/seo/public-content.ts` |
| `/markdown/[...path]` route already serves markdown | `apps/web/src/app/(public)/markdown/[...path]/route.ts` |
| Markdown responses currently send `Content-Type: text/plain` | `apps/web/src/lib/seo/response.ts:12` |
| That content type is pinned by a test contract | `apps/web/src/lib/seo/coverage-manifest.ts` |
| Middleware runs on the Edge runtime (Next 15.5, no `nodeMiddleware`) | `apps/web/next.config.ts:182`, `apps/web/package.json` |

## Architecture

### Serving location

All discovery documents are **route handlers**, not static files in `public/`.

Two reasons. First, the App Router ignores dot-prefixed directories, so
`src/app/.well-known/` is not a viable location. Second, static file serving
cannot set content types like `application/linkset+json`, which RFC 9727
requires.

Route handlers live under `src/app/(public)/well-known/…` and are exposed at
their spec-mandated paths by rewrites in `next.config.ts`:

```
/.well-known/api-catalog                    → /well-known/api-catalog
/.well-known/oauth-authorization-server     → /well-known/oauth-authorization-server
/.well-known/oauth-protected-resource       → /well-known/oauth-protected-resource
/.well-known/agent-skills/index.json        → /well-known/agent-skills/index.json
/.well-known/agent-skills/:name/SKILL.md    → /well-known/agent-skills/:name/SKILL.md
```

`auth.md` is served directly at `/auth.md` by a route handler directory named
`auth.md`, the same pattern `src/app/llms.txt/route.ts` already uses. It is
already reachable without authentication: middleware's `PUBLIC_ROUTES` contains
`/auth`, and the match is a `startsWith`.

These are added to the existing `rewrites()` array in `next.config.ts:250`.
Because that function returns a bare array, Next treats the entries as
`afterFiles` — they resolve *after* the filesystem and `public/`. That ordering
is fine here: the two existing static files under `public/.well-known/`
(`apple-app-site-association`, `assetlinks.json`) are untouched and none of the
paths above collide with them. If a future static file ever shadows one of these
paths, the fix is to move that entry into a `beforeFiles` group.

### Single source of truth

A new module tree, `apps/web/src/lib/agent-discovery/`. Each file has one
purpose, exports pure functions, and is independently testable. Route handlers
are thin — they call one builder and set headers.

| File | Responsibility | Depends on |
|---|---|---|
| `link-header.ts` | Site-wide `Link` header value and the discovery paths | nothing (see §1) |
| `endpoints.ts` | Canonical origins, OAuth endpoint URLs, scope vocabulary | `link-header.ts` |
| `api-catalog.ts` | Builds the RFC 9727 linkset object | `endpoints.ts` |
| `oauth-metadata.ts` | Builds AS + protected-resource documents | `endpoints.ts` |
| `skills.ts` | Skill registry; reads SKILL.md bodies; computes sha256 | `node:fs`, `node:crypto` |
| `auth-md.ts` | Renders the `auth.md` body | `endpoints.ts` |
| `markdown-negotiation.ts` | Edge-safe `Accept` parsing and route lookup | generated JSON only |

`markdown-negotiation.ts` must not import anything that touches `node:fs`. It is
consumed by `middleware.ts`, which runs on the Edge runtime.

Anything that needs to change in two places is wrong. The OAuth endpoint URLs
appear in the AS metadata, the protected-resource metadata, and `auth.md`; all
three read them from `endpoints.ts`.

## Detailed design

### 1. Link response headers

A new entry in `next.config.ts` `headers()` matching `/:path*`:

```
Link: </.well-known/api-catalog>; rel="api-catalog",
      </docs>; rel="service-doc",
      </llms.txt>; rel="describedby"; type="text/plain",
      </legal>; rel="terms-of-service"
```

The header value is generated by `link-header.ts` and imported into
`next.config.ts` by **relative** path (`./src/lib/agent-discovery/link-header`),
so the paths stay in sync with the routes that serve them. `next.config.ts` is
evaluated outside the Next module graph and cannot resolve the `@/` alias, so
`link-header.ts` must have no imports of its own — the handful of paths it needs
are literals in that file, and `endpoints.ts` imports *them* rather than the
reverse.

Only IANA-registered relation types are used. `api-catalog` is registered by
RFC 9727 §4. `service-doc`, `describedby`, and `terms-of-service` are all in the
IANA Link Relations registry. `service-desc` is deliberately **not** advertised
from the homepage — the OpenAPI document is on a different origin and belongs in
the API catalog's linkset, where it can be anchored correctly.

`/legal` is a single page in this codebase (`src/app/(public)/(seo)/legal`),
not a directory of sub-documents, so `terms-of-service` points there.

A per-page `Link: <…>; rel="alternate"; type="text/markdown"` is added by
middleware for pages that have a markdown twin — see §2.

### 2. Markdown for Agents

The hard constraint: middleware runs on Edge and cannot import
`public-content.ts`, which uses `node:fs` to scan MDX sources for docs and
use-case records. The route map must therefore be available to middleware as
plain data.

**Build step.** A new `apps/web/scripts/build-markdown-routes.mjs`, wired into
`next.config.ts` alongside the existing `build-content-timestamps.mjs`, emits
`apps/web/src/lib/seo/markdown-routes.json`:

```json
{ "/pricing": "/markdown/pricing.md", "/docs/work/sessions": "/markdown/docs/work/sessions.md" }
```

The file is generated, committed (matching how `content-timestamps.json` is
handled today), and tolerated as absent — if the import fails or the object is
empty, negotiation is simply inert and HTML is served, exactly as today.

**Middleware.** An early branch in `apps/web/src/middleware.ts`, before the
maintenance and auth logic:

```
if (accept ranks text/markdown >= text/html) and markdownRoutes[pathname]:
    rewrite → markdownRoutes[pathname]
```

`Accept` ranking is real q-value parsing in `markdown-negotiation.ts`, not a
substring check. `Accept: text/html, text/markdown;q=0.5` from a browser must
still get HTML. `Accept: text/markdown` or `text/markdown;q=1.0, text/html;q=0.8`
gets markdown. This is the entire point of the check: **HTML stays the default
for browsers.**

For any path present in `markdownRoutes`, middleware also appends to the
response:

```
Vary: Accept
Link: </markdown/…>; rel="alternate"; type="text/markdown"
```

`Vary: Accept` is set **only** on negotiable paths. Setting it site-wide would
fragment every CDN cache entry by request `Accept` header and destroy hit rate.

**Response headers.** `apps/web/src/lib/seo/response.ts` changes:

| Header | Before | After |
|---|---|---|
| `Content-Type` | `text/plain; charset=utf-8` | `text/markdown; charset=utf-8` |
| `Vary` | — | `Accept` |
| `x-markdown-tokens` | — | estimated token count |
| `Content-Disposition` | `inline` | `inline` (unchanged, deliberately) |
| `Link` rel=canonical | present | present |

`x-markdown-tokens` is `Math.ceil(markdown.length / 4)`. This is an estimate and
is documented as one in a code comment. Real token counts are tokenizer- and
model-specific; shipping a tokenizer to compute a hint header is not worth the
bundle cost. The header is advisory — agents use it to budget context.

**Contract updates.** `coverage-manifest.ts` pins
`requiredMarkdownHeaders['Content-Type']` to the old value and
`public-content.test.ts` asserts it. Both update to `text/markdown; charset=utf-8`.

### 3. Content Signals

`apps/web/public/robots.txt` gains one directive inside the `User-agent: *`
group, where contentsignals.org specifies it belongs:

```
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /
```

A comment above it states the declaration in prose, per the contentsignals.org
recommendation that the signal be human-legible too.

This says: index and cite Kortix content freely, use it to ground answers, do
not train models on it. It is coherent with the rest of this work, which exists
to invite agents in.

### 4. API Catalog

`GET /.well-known/api-catalog` → `application/linkset+json`, per RFC 9727 and the
RFC 9264 linkset format. Two anchors:

```json
{
  "linkset": [
    {
      "anchor": "https://api.kortix.com/v1",
      "service-desc": [{ "href": "https://api.kortix.com/v1/openapi.json", "type": "application/json" }],
      "service-doc":  [{ "href": "https://kortix.com/docs", "type": "text/html" }],
      "status":       [{ "href": "https://api.kortix.com/v1/health", "type": "application/json" }],
      "terms-of-service": [{ "href": "https://kortix.com/legal" }]
    },
    {
      "anchor": "https://kortix.com/api/ai",
      "service-doc": [{ "href": "https://kortix.com/docs", "type": "text/html" }],
      "describedby": [
        { "href": "https://kortix.com/llms.txt", "type": "text/plain" },
        { "href": "https://kortix.com/llms-full.txt", "type": "text/plain" }
      ]
    }
  ]
}
```

The second anchor is the existing paginated public-content index at
`/api/ai` — already rate-limited and already listed in `robots.txt`.

Cached with `MACHINE_CONTENT_CACHE_CONTROL`, the constant already used by
`llms.txt` and the markdown routes.

### 5. OAuth Authorization Server metadata

`GET /.well-known/oauth-authorization-server` → `application/json`:

```json
{
  "issuer": "https://kortix.com",
  "authorization_endpoint": "https://api.kortix.com/v1/oauth/authorize",
  "token_endpoint": "https://api.kortix.com/v1/oauth/token",
  "userinfo_endpoint": "https://api.kortix.com/v1/oauth/userinfo",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post"],
  "scopes_supported": ["profile"],
  "service_documentation": "https://kortix.com/docs",
  "agent_auth": {
    "register_uri": "https://kortix.com/contact",
    "identity_types": ["service_account"],
    "credential_types": ["client_secret"]
  }
}
```

`issuer` is `https://kortix.com` and the metadata is served at
`https://kortix.com/.well-known/oauth-authorization-server`. RFC 8414 §3
requires only that the *document location* derive from the issuer identifier;
the endpoints it advertises may live on any host. This is fully conformant.
Kortix's access tokens are opaque database rows with no `iss` claim, so there is
nothing for this identifier to contradict.

**`openid-configuration` is deliberately not published.** Kortix issues no
`id_token` and exposes no JWKS. An OIDC discovery document would advertise
capabilities that do not exist. The isitagentready check accepts either
document; we publish the true one.

`scopes_supported` lists `profile` only. That is the sole scope any route
actually enforces (`requireOAuthScope(c, 'profile')`). `machines:read` appears in
test fixtures but is gated by nothing in the API, so advertising it would invite
agents to request a scope that grants no additional access. When further scopes
gain enforcement, they are added to `endpoints.ts` and appear in both §5 and §6
automatically.

`agent_auth` is the Auth.md extension block — see §7 for why `register_uri`
points at `/contact`.

### 6. OAuth Protected Resource metadata

`GET /.well-known/oauth-protected-resource` → `application/json`, per RFC 9728:

```json
{
  "resource": "https://api.kortix.com/v1",
  "authorization_servers": ["https://kortix.com"],
  "scopes_supported": ["profile"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://kortix.com/docs"
}
```

`authorization_servers` lists the issuer identifier from §5, which is how a
client is expected to locate the AS metadata document.

**Known deviation.** RFC 9728 §3 derives the metadata path from the resource
identifier, which would place this document at
`https://api.kortix.com/.well-known/oauth-protected-resource/v1`. Serving it
from `kortix.com` is a discovery mirror. Strict clients performing host
derivation will not find it. Recorded as a follow-up rather than fixed here, so
this change remains a single reviewable, independently-deployable web unit.

### 7. auth.md

`GET /auth.md` → `text/markdown; charset=utf-8`.

The honest content, derived from the code:

- Kortix runs an OAuth 2.0 authorization-code flow with mandatory PKCE (S256).
- **There is no dynamic client registration.** `apps/api/src/oauth/index.ts`
  exposes `/authorize`, `/token`, and `/userinfo` and nothing else; clients are
  rows in `kortix.oauth_clients` provisioned out of band. `auth.md` says exactly
  this and directs agents to `/contact` to request credentials. `register_uri`
  in §5 points there for the same reason.
- Endpoints, supported grants, the scope vocabulary, and the token endpoint's
  per-client rate limit (`TOKEN_RATE_LIMIT` / `TOKEN_RATE_WINDOW_MS` in
  `apps/api/src/oauth/index.ts` — currently 20 requests per minute).
- Links to `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/.well-known/api-catalog`, and
  `/llms.txt`.

Rendered by `auth-md.ts` from the same `endpoints.ts` constants as §5 and §6, so
the three documents cannot disagree.

### 8. Agent Skills index

Three new skills, authored as markdown under
`apps/web/src/content/agent-skills/<name>/SKILL.md`:

| Skill | Purpose |
|---|---|
| `kortix-api` | Authenticate against and call `api.kortix.com/v1`; where the OpenAPI spec is |
| `kortix-sdk` | Install and use `@kortix/sdk` |
| `kortix-agent-content` | Read Kortix content as markdown: `llms.txt`, `/api/ai`, `Accept: text/markdown` |

These are outward-facing. The repository's existing skills under `.claude/skills/`
are internal engineering workflow (release process, secrets handling, worktrees)
and are **not** published.

`GET /.well-known/agent-skills/index.json` → `application/json`:

```json
{
  "$schema": "https://agentskills.io/schemas/v0.2.0/index.json",
  "skills": [
    {
      "name": "kortix-api",
      "type": "skill",
      "description": "…",
      "url": "https://kortix.com/.well-known/agent-skills/kortix-api/SKILL.md",
      "sha256": "…"
    }
  ]
}
```

`GET /.well-known/agent-skills/:name/SKILL.md` serves the file body as
`text/markdown; charset=utf-8`.

**Digest integrity.** `skills.ts` reads each SKILL.md with `node:fs` and computes
its sha256 with `node:crypto` from the exact bytes the sibling route serves. No
build script, no committed hash, no drift possible. This runs in a route handler
on the Node runtime, so `fs` is available — the Edge constraint from §2 does not
apply here.

Both routes are `force-static` with `revalidate = 3600`, matching `llms.txt`.

### 9. WebMCP

A `'use client'` component, `apps/web/src/components/agent/web-mcp-tools.tsx`,
mounted in the root `layout.tsx` so every page — including the homepage the
check probes — exposes it.

```
useEffect(() => {
  if (!('modelContext' in navigator)) return;
  const registration = navigator.modelContext.provideContext({ tools });
  return () => registration?.unregister?.();
}, []);
```

Feature-detected, so it is inert in browsers without WebMCP. Cleaned up on
unmount so client navigation does not stack registrations.

Four read-only tools, each backed by an endpoint that already exists:

| Tool | Backing endpoint |
|---|---|
| `search_kortix_docs` | `/api/search` (fumadocs Orama index) |
| `list_kortix_pages` | `/api/ai` (paginated public-content index) |
| `get_kortix_page_markdown` | `/markdown/<slug>.md` |
| `get_kortix_pricing` | `PRICING_PLANS` from `@/features/billing/pricing-plans` |

No tool mutates state, and none requires authentication. Each has a name,
description, JSON Schema `inputSchema`, and an `execute` callback.

## Documentation-only deliverables

`docs/agent-discovery/dns-aid.md` contains:

- The exact SVCB/HTTPS ServiceMode records to publish for
  `_index._agents.kortix.com` and `_a2a._agents.kortix.com`, with `alpn` and
  `endpoint` parameters filled in for the endpoints this change creates.
- The DNSSEC signing requirement for the public discovery zone.
- Provider-agnostic instructions, plus the Cloudflare-specific form.
- A section on the MCP Server Card: the exact `server-card.json` document to
  publish at `/.well-known/mcp/server-card.json`, explicitly gated on an MCP
  transport endpoint existing. It is not published today because there is none.

## Testing

Per the repository testing discipline, every change ships with tests in the same
change. All co-located `bun:test`, run under `bun test --isolate`.

| Test | Asserts |
|---|---|
| `agent-discovery/api-catalog.test.ts` | Linkset shape; every `href` absolute; anchors match `endpoints.ts` |
| `agent-discovery/oauth-metadata.test.ts` | Required RFC 8414/9728 fields; no `id_token` or `jwks_uri` claim; grants match `apps/api` |
| `agent-discovery/skills.test.ts` | Every index entry resolves to a readable file; sha256 matches the served bytes |
| `agent-discovery/link-header.test.ts` | Parses as RFC 8288; only registered relation types |
| `agent-discovery/markdown-negotiation.test.ts` | q-value ranking: browser `Accept` → HTML, agent `Accept` → markdown; unknown path → no rewrite |
| `agent-discovery/auth-md.test.ts` | Endpoints in the body match `endpoints.ts` |
| `seo/public-content.test.ts` (updated) | New `text/markdown` content type and `Vary: Accept` |
| `web-mcp-tools.test.tsx` | Inert without `navigator.modelContext`; unregisters on unmount |

An end-to-end check is not added; these are pure-function builders and one
middleware branch, all covered by unit tests. Manual verification after deploy
is a `curl -I https://kortix.com/` and a re-run of the isitagentready audit.

## Risks

**Content type change.** Moving `/markdown/*` from `text/plain` to
`text/markdown` means some browsers offer a download instead of rendering
inline. `Content-Disposition: inline` is retained to counter this. The `/markdown/*`
paths are machine-facing; human readers use the HTML pages.

**Cache fragmentation.** `Vary: Accept` fragments CDN cache entries by request
header. Confined to paths in `markdown-routes.json`; never applied site-wide.

**Edge bundle size.** `markdown-routes.json` is imported into middleware and
therefore ships in the Edge bundle. It holds path strings only — no titles, no
descriptions, no timestamps.

**Middleware ordering.** The negotiation branch runs before the maintenance and
auth checks. It must only fire for paths in `markdown-routes.json`, all of which
are public content, so it cannot leak an authenticated page as markdown.

## Follow-ups

1. Serve canonical OAuth metadata from `apps/api` at
   `api.kortix.com/.well-known/oauth-authorization-server` and
   `.../oauth-protected-resource/v1` for strict RFC 9728 host derivation.
2. Apply the DNS-AID records from `docs/agent-discovery/dns-aid.md` and sign the
   zone with DNSSEC.
3. Publish an MCP Server Card once an MCP transport endpoint exists.
4. Consider self-service OAuth client registration, which would let
   `agent_auth.register_uri` point at a real registration endpoint rather than
   a contact form.
