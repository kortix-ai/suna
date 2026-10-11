# Kortix Apps router

This Worker routes one-level App hostnames to the matching Kortix API. It signs
the original host, method, path, and query with that environment's edge secret.
The API verifies the signature before it reads App state or starts a sandbox.

## Edge cache

The Worker caches public static App files in `caches.default` (per Cloudflare
data center). It stores a response only when all of these are true:

- The request is a `GET` with no `Range` or `Upgrade` header.
- The API set `x-kortix-edge-cacheable: public`. The API sets it only on a
  static App with access mode `public`, and strips it from every response an
  App runtime sends, so a server App cannot opt in.
- The response is a `200` whose `Cache-Control` has `public` and `immutable`
  (content-hashed build output; HTML and other files revalidate at the API).
- The response has no `Set-Cookie` and varies on nothing but `Accept-Encoding`.

The cache key is the App URL (host, path, query) plus the negotiated encoding
(`br`, `gzip`, or `identity`). The Worker forwards only that encoding to the
API, so one key holds one body. Another App host never shares a key. In
workerd (Miniflare 4), a `gzip`-only client request reached the Worker as
br-capable and got the decoded body from the `br` entry: the runtime handles
transcoding, and the encoding part of the key is a guard, not a requirement.

The stored copy has `Cache-Control: public, max-age=3600`. A hit restores the
API's browser policy. Responses carry `x-kortix-edge-cache: HIT` or `MISS` for
every cache-eligible request.

The API also sends `Cloudflare-CDN-Cache-Control: no-store` on every App
response. The API hostnames are Cloudflare-proxied, and Cloudflare's default
cache keys on the API host and path, not the App host. That header keeps every
cache before this Worker empty.

Limits:

- There is no purge. A public App switched to private, or a deleted App, keeps
  its cached immutable files reachable by exact URL for up to 1 hour (the edge
  TTL) in each data center that cached them. HTML is never cached, so no page
  links to them. Purge-by-host on access change needs a Cloudflare API token in
  the API; it is not built.
- A deploy needs no purge: a changed file gets a new hashed name.

Required Cloudflare resources:

- A proxied `*.apps.kortix.com` DNS record.
- A Worker route for `*.apps.kortix.com/*`.
- An Advanced Certificate Manager certificate containing `*.apps.kortix.com`.
- The `DEV_EDGE_SECRET`, `STAGING_EDGE_SECRET`, `PROD_EDGE_SECRET`, and
  `PREVIEW_EDGE_SECRET` Worker secrets.

Run the `Configure Kortix Apps Edge` GitHub workflow after the Worker deploys.
The workflow creates the proxied wildcard DNS record when it is absent. It
refuses to replace a conflicting record. It also verifies the Worker route,
secret bindings, public DNS, TLS, and the signed Dev routing path.

Each API environment must receive the corresponding value as
`KORTIX_APPS_EDGE_SECRET`. The API falls back to its existing `API_KEY_SECRET`
when the dedicated value is absent. Do not store secret values in
`wrangler.toml` or another tracked file.

Deploy:

```sh
npx --yes wrangler@4.34.0 secret put DEV_EDGE_SECRET
npx --yes wrangler@4.34.0 secret put STAGING_EDGE_SECRET
npx --yes wrangler@4.34.0 secret put PROD_EDGE_SECRET
npx --yes wrangler@4.34.0 secret put PREVIEW_EDGE_SECRET
npx --yes wrangler@4.34.0 deploy
```
