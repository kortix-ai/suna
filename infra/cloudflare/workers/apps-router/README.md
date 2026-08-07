# Kortix Apps router

This Worker routes one-level App hostnames to the matching Kortix API. It signs
the original host, method, path, and query with that environment's edge secret.
The API verifies the signature before it reads App state or starts a sandbox.

Required Cloudflare resources:

- A proxied `*.apps.kortix.com` DNS record.
- A Worker route for `*.apps.kortix.com/*`.
- An Advanced Certificate Manager certificate containing `*.apps.kortix.com`.
- The `DEV_EDGE_SECRET`, `STAGING_EDGE_SECRET`, `PROD_EDGE_SECRET`, and
  `PREVIEW_EDGE_SECRET` Worker secrets.

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
