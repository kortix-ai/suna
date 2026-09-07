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
| signed localhost target | `apps/api/src/sandbox-proxy/preview-bridge.ts` |
| in-sandbox localhost HTTP bridge | `apps/kortix-sandbox-agent-server/src/preview-bridge.ts` |
| in-sandbox WebSocket bridge | `apps/kortix-sandbox-agent-server/src/proxy.ts` |
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

## App traffic reaches localhost inside the sandbox

The public preview hostname stays unchanged. App traffic follows this route:

```text
preview origin -> API authorization -> provider daemon ingress (8000)
               -> signed daemon bridge -> http://localhost:<app-port>
```

Direct provider ingress can replace `Host` with an internal name such as
`3000-<sandbox>.aec.local`. Vite rejects that host with `403`. A proxy can also
break Next.js Server Actions when `Origin` and `x-forwarded-host` disagree.
Changing generated framework allowlists does not repair this shared transport.

The API signs `X-Kortix-Preview-Target: port.exp.signature` with the sandbox
service key. The HMAC-SHA256 input is `localhost-preview:port.exp`; the signature
uses base64url and expires after 60 seconds. The daemon strips the internal
`/__kortix_preview` prefix and forwards the original app path and query.
Both HTTP and WebSocket requests reach the app with `Host` and
`x-forwarded-host` set to `localhost:<app-port>`. `Origin`, when present, uses
that same HTTP origin. `Referer` keeps its path and query on that origin.

The bridge removes platform credentials, provider credentials, internal headers,
and hop-by-hop headers before forwarding. Bridge authorization uses the requested
logical port. Legacy ingress authorization uses the provider's effective port,
including PTY paths that the provider remaps to the daemon. Daemon, OpenCode, and
credential-bearing loopback listeners cannot be selected as app targets. Public shares receive only an app
target ticket, never a signed user context.

WebSocket upgrades preserve the negotiated subprotocol and immediate HMR messages.
No `Sec-WebSocket-Protocol` response header is sent when no protocol was selected.
Cookie-authenticated app sockets retain app-owned `token` values. Platform
credentials and `public_share`/`wake` parameters do not reach the app.

### Compatibility and rollout

The API checks the running daemon's explicit preview capability before choosing
the transport. A supported daemon uses the localhost bridge. An old daemon or
an unavailable capability probe retains the previous direct app-port ingress.
This decision happens before application bytes are sent. A failed bridge request
is never replayed through legacy ingress.

Capability discovery has a one-second total deadline, including provider ingress
lookup. Concurrent requests for the same runtime and service key share one probe.
Positive results expire after 15 seconds; negative results expire after two seconds.

The original host-check problem can persist on an old daemon until its safe
update completes. Capability detection prevents the API deployment from turning
that delay into a new preview outage. A forged bridge request still fails closed:
the reserved prefix cannot be interpreted as an app-selected daemon control path.

Verify the running daemon, not only the API SHA or a downloaded binary. Runtime
asset reconciliation can stage a new daemon while active work defers its swap.
Before rollout, verify one pre-change session before and after convergence, and
one new session. Exercise app HTTP, WebSocket hot reload, cookies, Server Actions,
and the unchanged chat/files/PTY control paths. Do not restart active user work
to satisfy this gate. A staged binary is not proof of a completed swap.

### Diagnosis

1. Compare a request directly to the app with one through its preview origin.
2. Inspect the app's received `Host`, `Origin`, and `x-forwarded-host`.
3. A provider hostname at the app means the request used legacy ingress.
   Check the running daemon's capability and pending runtime update.
4. A daemon `401` without `X-Kortix-Preview-Bridge: 1` indicates bridge/auth failure.
   The API reports that failure as `502`; an app's marked `401` stays `401`.
5. Check the Next.js server log for Server Action rejection details.
   A successful page GET alone does not verify a Server Action.

## What is still not identical to reaching the box directly

- `X-Frame-Options` and CSP `frame-ancestors` are stripped from responses, so the
  preview can be embedded in the Kortix session panel.
- App requests use a localhost origin, not the browser's public preview origin.
  The public proxy context remains in `X-Forwarded-Prefix`.
- The API buffers request bodies; the daemon forwards the body stream.
  App mutations are not replayed after an ambiguous failure. App responses are
  not reclassified as provider errors solely because they return `401` or `5xx`.
- `Accept-Encoding` is forced to `identity` upstream, so bytes pass through
  without a decompress/recompress step.
