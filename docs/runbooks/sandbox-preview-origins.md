# Sandbox preview origins

Every sandbox port a user can open in a browser is served on its own hostname:

```
{env}-p{port}-{sandbox-label}.p.kortix.com
dev-p8081-sbx-01m0g4hxcm32bx5r1gpyzdyc1h.p.kortix.com
```

Locally the same shape without the environment prefix:
`p8081-sbx-01m0….localhost:8008`.

## Every environment

| environment | preview hostname | edge | TLS | trust boundary |
| --- | --- | --- | --- | --- |
| dev | `dev-p{port}-{sandbox}.p.kortix.com` | `kortix-preview-router` Worker | one advanced cert pack for `*.p.kortix.com` | signed `x-kortix-preview-host` |
| staging | `staging-p{port}-{sandbox}.p.kortix.com` | same Worker | same cert | same |
| prod | `prod-p{port}-{sandbox}.p.kortix.com` | same Worker | same cert | same |
| self-host (domain) | `{env}-p{port}-{sandbox}.{KORTIX_PREVIEW_BASE_DOMAIN}` | bundled Caddy | per-hostname ACME HTTP-01, gated by `/v1/apps/edge/tls-check` | the operator's own proxy (`KORTIX_PREVIEW_ALLOW_DIRECT_EDGE=true`, real `Host` only) |
| self-host (no domain) | — | — | — | previews use the path proxy |
| local dev | `p{port}-{sandbox}.localhost:{apiPort}` | none | none (`*.localhost` is a trustworthy origin) | localhost |
| prod US-East-2 shadow | — | — | — | path proxy: its sandboxes are not in the prod database the wildcard routes to |
| PR preview environments | — | — | — | path proxy, for the same reason |

One wildcard certificate and one Worker cover all three managed environments
because the environment is the first label segment. A deployment that declares
no `KORTIX_PREVIEW_BASE_DOMAIN` keeps the path proxy, which always works.

Both entry points are covered in every row: the session panel's authenticated
preview, and a public share link (which carries `?public_share=<token>` and is
exchanged for the same cookie).

## Why not a path prefix

The path form `/v1/p/{sandbox}/{port}/…` still exists and still works — for
programmatic clients. It is not a browser surface. An app served under a path
prefix escapes it the moment it emits anything root-absolute:

| the app writes | the browser resolves to | result under a path prefix |
| --- | --- | --- |
| `<a href="/learn">` | `https://dev-api.kortix.com/learn` | API 404 |
| `fetch('/api/items')` | `https://dev-api.kortix.com/api/items` | API 404 |
| `history.pushState('/x')` | address bar leaves the prefix | reload 404s |
| `url(/bg.png)` in CSS | `https://dev-api.kortix.com/bg.png` | missing asset |
| service worker scope `/` | the API origin | registration rejected |
| `new WebSocket('/hmr')` | the API origin | no hot reload |

Only `Location:` redirects can be repaired at the proxy, and they already are
(`sanitizeRedirectLocation`). Nothing else is visible to it. Rewriting HTML does
not close the set either — a minified bundle builds URLs at runtime.

A second reason: under the path form, arbitrary sandbox code runs on the SAME
origin as the Kortix API, so two of a user's previews share cookies and storage
with each other. An origin per preview puts each app in its own principal.

## The pieces

| piece | file |
| --- | --- |
| hostname shape (build + match) | `apps/api/src/sandbox-proxy/preview-hosts.ts` |
| signed session cookie | `apps/api/src/sandbox-proxy/preview-session.ts` |
| request handling | `apps/api/src/sandbox-proxy/preview-origin.ts` |
| WebSocket upgrade | `apps/api/src/sandbox-proxy/ws-proxy.ts` |
| edge signature | `apps/api/src/shared/edge-signature.ts` |
| edge Worker | `infra/cloudflare/workers/preview-router/` |
| provisioning (cloud) | `.github/workflows/configure-preview-edge.yml` |
| on-demand-TLS gate (self-host) | `apps/api/src/edge/tls-check.ts` |
| self-host Caddy + compose | `apps/cli/src/self-host/compose-assets.ts` |
| client URL building | `packages/sdk/src/core/session/url.ts` |

## Auth

1. The client opens the preview with a one-shot `?token=` (a Supabase JWT, a
   Kortix token, or a `?public_share=` token).
2. The proxy validates it, mints an HMAC-signed cookie bound to that one
   (sandbox, port), and — on a top-level navigation — redirects once to the same
   URL without the token, so it never lingers in the address bar or a Referer.
3. Every later request rides the cookie. That is the only credential an app's own
   code can carry: `fetch('/api')` and `new WebSocket('/hmr')` cannot attach a
   header or a query parameter.

Two cookie copies are set, `__kortix_preview` and `__kortix_preview_chips`
(`Partitioned`). A preview is normally an iframe inside the Kortix web app — a
third-party context where an ordinary cookie may be blocked — while the same URL
opened in its own tab is first-party and cannot see a partitioned cookie. One
copy covers each; verification accepts either.

The cookie is stateless by design. The API runs several tasks behind one load
balancer, so anything remembered in a process is invisible to the next request.

## Trust boundary

The Worker forwards to the API's own origin, so the browser's hostname survives
only in `x-kortix-preview-host`. It is signed
(`timestamp \n host \n method \n path?query`, HMAC-SHA256) and the API refuses a
claimed host whose signature does not verify — otherwise anyone reaching the API
origin could name any preview.

The secret is `KORTIX_PREVIEW_EDGE_SECRET` in the API environment, falling back
to `API_KEY_SECRET`, and must equal the Worker secret for that environment
(`DEV_EDGE_SECRET` / `STAGING_EDGE_SECRET` / `PROD_EDGE_SECRET`). A self-host
behind its own reverse proxy sets `KORTIX_PREVIEW_ALLOW_DIRECT_EDGE=true`, which
takes the real `Host` header and requires no signature.

## Order of operations — the domain goes last

Advertising the domain is what makes clients stop using the path proxy. Do it
before the certificate is active and every preview fails the TLS handshake
instead of degrading. So:

1. Worker route + secret for the environment.
2. Wildcard DNS record.
3. Certificate pack ACTIVE (verify: `curl -sI https://<env>-p8081-sbx-x.p.kortix.com/`
   returns an HTTP status rather than a handshake failure).
4. Only then set `KORTIX_PREVIEW_BASE_DOMAIN` for that environment.

Removing the variable again is a complete rollback: clients fall straight back
to `/v1/p/{sandbox}/{port}/`.

## Provisioning a new environment

Run **Configure Sandbox Preview Edge** (`workflow_dispatch`). It is idempotent
and does the whole thing:

1. verifies the Worker route,
2. reads each environment's own `API_KEY_SECRET` from its Secrets Manager blob
   (`kortix-<env>-env`, the same blob that feeds its ECS tasks) and pushes it as
   that environment's Worker secret — so no secret is ever copied by hand or
   duplicated into a second system,
3. keeps zone header-transform rules off preview hosts,
4. creates the proxied wildcard DNS record,
5. orders the advanced certificate pack if missing and waits for it to go active,
6. probes a synthetic preview host end to end.

Then set `KORTIX_PREVIEW_BASE_DOMAIN` for that environment (see the ordering
section above).

Universal SSL covers `kortix.com` and `*.kortix.com` — one label deep. A preview
host is two, so the advanced certificate pack is not optional: without it the TLS
handshake fails before the Worker is ever reached.

## Self-hosting

A self-host has no Cloudflare Worker and no wildcard certificate, so it uses the
same mechanics Kortix Apps already uses on a self-host:

- `kortix self-host init` asks for a **preview base domain**. It sets
  `KORTIX_PREVIEW_BASE_DOMAIN` and `KORTIX_PREVIEW_ALLOW_DIRECT_EDGE=true`.
- The bundled Caddy gains a `*.{$KORTIX_PREVIEW_BASE_DOMAIN}` site block that
  reverse-proxies to `kortix-api:8008` and issues a certificate **per hostname**
  on first request (`tls { on_demand }`). The operator needs a `*.<domain>` DNS
  record pointing at the instance — **not** a wildcard certificate.
- Issuance is bounded by the global `on_demand_tls { ask … }`, which points at
  `/v1/apps/edge/tls-check`. That one endpoint answers for both wildcard families
  (Caddy allows exactly one global `ask`): 200 only for a real App host or a real
  preview host, so a random hostname aimed at the box cannot mint certificates.
- With no Worker to sign the claimed host, `KORTIX_PREVIEW_ALLOW_DIRECT_EDGE`
  tells the API that its own reverse proxy is the trust boundary. In that mode
  the API reads the **real** `Host` header and ignores `x-kortix-preview-host`
  entirely, so nobody reaching the API directly can name a preview by setting a
  header.
- Skipping the prompt is a supported answer: previews stay on the path proxy.
- A laptop instance (no domain, no Caddy) needs nothing — the SDK sees a
  localhost API and uses `p{port}-{sandbox}.localhost:{apiPort}`.

The rendered Caddyfile is checked against real Caddy in
`apps/cli/src/self-host/__tests__/compose-assets.test.ts`.

## Deployments without a preview domain

`previewBaseDomain()` returns null when the API origin has no registrable domain
(e.g. in-cluster `http://kortix-api:8008`). Then `GET /v1/p/config` answers
`{"preview_url_template": null}` and clients keep using the path proxy. Set
`KORTIX_PREVIEW_BASE_DOMAIN` to opt a self-host in.

## What stays on the path form, and why that is the right answer

Preview origins replace the path proxy for **browser** traffic. Three things
deliberately keep using `/v1/p/…`, and none of them is a migration leftover:

| surface | why |
| --- | --- |
| the runtime control channel (`runtime_url`, port 8000 / Platinum 4096) | Not a browser surface, so an origin buys it nothing. Programmatic callers (CLI, SDK, mobile) hold no cookie jar and send `Authorization: Bearer` per request; on an origin every one of those would re-establish a host session through `resolveExternalIdFromHostLabel`, whose predicate cannot use the `external_id` index. It would also put turn delivery behind wildcard DNS, the certificate pack and the edge Worker — a cert fault would stop agents, not just previews. |
| `POST /v1/p/auth`, `/v1/p/share`, `GET /v1/p/config`, `GET /v1/p/public-share/:token` | Control endpoints with no `(sandbox, port)` pair to name. `/v1/p/config` is the endpoint that *tells* a client an origin exists, so it can never live on one. |
| `session_sandboxes.base_url`, `project_sessions.sandbox_url` | Durable rows written once from `KORTIX_URL` — a cloudflared tunnel in local dev. Writing an origin into them would re-create the derived-domain bug and would break the "unset the variable" rollback for every row already written. |

Only two functions decide which form anything gets: `previewOriginFor` /
`previewUrlTemplate` on the server, and `SubdomainUrlOptions.previewUrlTemplate`
on the client. Nothing else may test for a preview domain, branch on
`INTERNAL_KORTIX_ENV`, or concatenate `/p/{id}/{port}`.

If a **browser** ever does end up on a path preview where an origin exists,
`prefix-escape.ts` still repairs the navigation — and now logs a WARN saying so.
On a deployment with origins that log line means the cutover has a hole.

## What a person sees when they cannot be served

A preview origin is a real address: people paste and bookmark it. A document
navigation that cannot be served gets a page, never JSON — what the address is,
plus a **Sign in to Kortix** action that goes to `/preview/authorize` on the web
app and returns with a one-shot token (`preview-gate-page.ts`). The action uses
`target="_top"` so a sign-in started inside the session panel's iframe does not
try to render the whole web app in a preview pane. Sub-resources and XHR keep
getting JSON — an app's own `fetch('/api')` must never be handed HTML.

`/preview/authorize` validates its `to` parameter against the hostname shape the
deployment serves before redirecting. Without that it would be an open redirect
that also hands over a bearer token.

## What is still not identical to reaching the box directly

- `X-Frame-Options` and CSP `frame-ancestors` are stripped from responses, so the
  preview can be embedded in the Kortix session panel.
- The upstream sees `Host`/`x-forwarded-host` of the sandbox ingress, not the
  preview hostname. This is deliberate: frameworks that check `Origin` against
  `Host` on mutations (Next.js Server Actions, SvelteKit, Django CSRF) reject a
  mismatch. The true public origin is passed as `X-Forwarded-Prefix`.
- Request bodies are buffered, not streamed, because the proxy retries an
  attempt that fails before delivery.
- `Accept-Encoding` is forced to `identity` upstream, so bytes pass through
  without a decompress/recompress step.
